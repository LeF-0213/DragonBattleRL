// ============================================================
// main.js - 엔트리 포인트
// ============================================================
// 역할:
// - index.html의 UI(드래곤 선택, 배경 선택, 시작 버튼, 도움말 모달, 상단 HP/쿨타임 바)를 모두 연결.
// - Game 클래스와 CoreGame 환경을 생성하고, requestAnimationFrame 루프로 게임을 실행.
// - Input → Game.buildPlayerActionFromInput() → CoreGame.step() → Game.draw() → UI 업데이트.
// - arena-panel(Self-Play Arena Watch Only) 버튼으로 “하드 룰기반 AI vs 하드 룰기반 AI” 관전 모드 실행
//
// 가정:
// - 캔버스 id: "game-canvas"
// - 선택 UI: #character-select, .dragon-option, .bg-option, #start-game-btn
// - 도움말 모달: #help-btn, #help-modal, #help-close, #help-backdrop
// - 상단 UI 오버레이: #ui-overlay, #player-hp, #ai-hp, #player-cd, #ai-cd
// ============================================================

import { GAME_CONFIG } from './game/config.js';
import { Game } from './game/Game.js';

let game = null;                 // Game 인스턴스
let running = false;             // 게임 루프가 돌아가는지 여부
let lastTimestamp = 0;           // 이전 프레임의 timestamp (ms 단위, requestAnimationFrame 인자)
let selectedDragonColor = null;  // 'black' | 'white'
let selectedBgIndex = null;      // 0, 1, 2 (배경 3개)
let difficulty = 'easy';         // 'easy' | 'normal' | 'hard
let easyAIShootTimer = 0;

// -------------------------------
// 통계(전투 결과용) - 전역
// -------------------------------
const stats = {
    player: {
      attacksHit: 0,   // 내 공격으로 상대 HP가 줄어든 횟수(누적 감소량)
      blocks: 0,       // W 반사 성공 횟수
      heals: 0,        // 회복된 HP량(누적 증가량)
    },
    ai: {
      attacksHit: 0,
      blocks: 0,
      heals: 0,
    },
  };
  // 이전 HP 저장(증감으로 공격성공/회복 카운트)
  const prevHP = {
    player: null,
    ai: null,
  };

// -------------------------------
// Arena Watch (Self-Play) 상태
// -------------------------------
let arenaRunning = false;
let arenaRafId = null;
let arenaLastTimestamp = 0;

// -------------------------------
// PPO(TF.js) 관련 상수/캐시
// -------------------------------

// 관측 차원(학습 코드와 동일 스펙)
const MAX_PROJECTILES = 40;
const MAX_ITEMS = 12;
const OBS_DIM = 1 + 10 + 10 + MAX_PROJECTILES * 7 + MAX_ITEMS * 4;

// Multi-discrete action head 구성
const ACTION_DIMS = [3, 3, 2, 2, 2, 2, 2, 2, 2, 2];
const ACTION_LOGITS_DIM = ACTION_DIMS.reduce((a, b) => a + b, 0);

// 쿨다운 정규화 상한(학습 스펙과 맞춤)
const CD_MAX = { Q: 10, W: 20, E: 30, R: 70, D: 180, F: 300 };

// TF.js 모델 경로
const HARD_POLICY_TFJS_URL = './checkpoints/hard_policy_tfjs/model.json';
const LATEST_POLICY_TFJS_URL = './checkpoints/latest_policy_tfjs/model.json';

// TF.js 모델 캐시
let tfLib = null;               // 라이브러리 자체
let tfLoadPromise = null;       // 라이브러리 로딩 상태 확인용
let hardPolicyModel = null;
let latestPolicyModel = null;

// 중복 로딩 방지를 위한 Promise들
let hardPolicyLoadPromise = null;
let latestPolicyLoadPromise = null;

// -------------------------------
// DOM 요소 헬퍼
// -------------------------------
function $(selector) {
    return document.querySelector(selector);
}

function $all(selector) {
    return Array.from(document.querySelectorAll(selector));
}

// 0~1 범위 제한
function clamp01(x) {
    return Math.max(0, Math.min(1, x));
}

// 가장 높은 확률 고르기
function argmax(arr) {
    let bi = 0;
    let bv = arr[0];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] > bv) {
            bv = arr[i];
            bi = i;
        }
    }
    return bi;
}

// CoreGame 액션 기본값(아무 행동 안 함)
function zeroAction() {
    return {
      moveX: 0,
      moveY: 0,
      shoot: false,
      useQ: false,
      useW: false,
      useE: false,
      useR: false,
      useD: false,
      useF: false,
    };
}

// -------------------------------
// 시작 버튼 활성화 조건 체크
// -------------------------------
function canStartGame() {
    return selectedDragonColor !== null && selectedBgIndex !== null && game !== null;
}

function updateStartButtonState(startButton) {
    const canStart = canStartGame();
    startButton.disabled = !canStart;
}

// -------------------------------
// 통계 초기화
// -------------------------------
function resetStats() {
    stats.player.attacksHit = 0;
    stats.player.blocks = 0;
    stats.player.heals = 0;
    stats.ai.attacksHit = 0;
    stats.ai.blocks = 0;
    stats.ai.heals = 0;
    prevHP.player = null;
    prevHP.ai = null;
    easyAIShootTimer = 0;
}

// -------------------------------
// 통계 갱신 로직
// -------------------------------
function accumulateStatsFromStep(coreGame, stepResult) {
    const state = coreGame.getRenderState();
    const player = state.player;
    const ai = state.ai;

    const hpP = player?.hp ?? 0;
    const hpA = ai?.hp ?? 0;

    // 첫 프레임이면 기준값만 세팅
    if (prevHP.player === null) prevHP.player = hpP;
    if (prevHP.ai === null) prevHP.ai = hpA;

    const dP = hpP - prevHP.player;
    const dA = hpA - prevHP.ai;

    // HP 감소 -> 상대의 공격 성공으로 카운트
    if (dP < 0) stats.ai.attacksHit += Math.abs(dP);
    if (dA < 0) stats.player.attacksHit += Math.abs(dA);

    // HP 증가 
    if (dP > 0) stats.player.heals += Math.abs(dP);
    if (dA > 0) stats.ai.heals += Math.abs(dA);

    prevHP.player = hpP;
    prevHP.ai = hpA;

    // CoreGame.info.events 안에 들어온 이벤트로 반사(w) 횟수 카운트
    const events = stepResult.info?.events || [];
    for (const ev of events) {
        if (ev.type === 'reflect') {
            if (ev.by === 'player') stats.player.blocks += 1;
            else if (ev.by === 'ai') stats.ai.blocks += 1;
        }
    }
}

// HP 바 렌더링
function renderHpBar(container, hp, hpMax, isPlayer) {
    if (!container) return;
    container.innerHTML = '';

    const fullCount = Math.max(0, Math.floor(hp));
    const maxCount = Math.max(0, Math.floor(hpMax));

    for (let i = 0; i < maxCount; i++) {
        const cell = document.createElement('div');
        cell.classList.add('hp-cell');
        if (i < fullCount) {
            cell.classList.add('full');
            cell.classList.add(isPlayer ? 'blue' : 'red');
        }
        container.appendChild(cell);
    }
}

// 쿨타임 랜더링
function renderCooldowns(container, cd) {
    if (!container) return;
    container.innerHTML = '';

    const keys = ['Q', 'W', 'E', 'R', 'D', 'F'];

    keys.forEach((k) => {
        const time = cd[k] ?? 0;
        const wrapper = document.createElement('div');
        wrapper.classList.add('cd-skill');

        const label = document.createElement('span');
        label.classList.add('cd-label');
        label.textContent = k;

        const value = document.createElement('span');
        value.classList.add('cd-time');
        value.textContent = time > 0.05 ? time.toFixed(1) : '-';

        wrapper.appendChild(label);
        wrapper.appendChild(value);
        container.appendChild(wrapper);
    });
}

// -------------------------------
// 상단(이제는 하단) UI 오버레이 갱신
// -------------------------------
function updateUIOverlay(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer) {
    if (!game) return;
    const ui = game.getUIState();
    renderHpBar(playerHpContainer, ui.playerHP, ui.playerHPMax, true);
    renderHpBar(aiHpContainer, ui.aiHP, ui.aiHPMax, false);
    renderCooldowns(playerCdContainer, ui.playerCd || {});
    renderCooldowns(aiCdContainer, ui.aiCd || {});
}

// -------------------------------
// 결과 오버레이 표시
// -------------------------------
function showResultOverlay(stepResult) {
    // 이전에 만든 결과창이 있으면 제거
    const old = $('#result-overlay');
    if (old) old.remove();

    const state = game.core.getRenderState();
    const playerAlive = state.player?.alive;
    const aiAlive = state.ai?.alive;

    let winnerText='무승부';
    if (playerAlive && !aiAlive) winnerText = '플레이어 승리';
    else if (!playerAlive && aiAlive) winnerText = 'AI 승리';
    const container = document.createElement('div');
    container.id = 'result-overlay';
    container.style.position = 'absolute';
    container.style.inset = '0';
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.justifyContent = 'center';
    container.style.zIndex = '40';
    container.style.background = 'rgba(0,0,0,0.6)';
    const panel = document.createElement('div');
    panel.style.minWidth = '320px';
    panel.style.maxWidth = '480px';
    panel.style.padding = '20px 24px';
    panel.style.borderRadius = '16px';
    panel.style.background = 'rgba(12,14,24,0.95)';
    panel.style.color = '#f5f5f5';
    panel.style.boxShadow = '0 20px 60px rgba(0,0,0,0.7)';
    panel.style.fontSize = '14px';
    panel.style.lineHeight = '1.5';
    const title = document.createElement('h2');
    title.textContent = '전투 결과';
    title.style.margin = '0 0 12px';
    title.style.fontSize = '20px';
    const winner = document.createElement('div');
    winner.textContent = `승자: ${winnerText}`;
    winner.style.marginBottom = '8px';
    winner.style.fontWeight = '700';
    const detail = document.createElement('div');
    detail.innerHTML = `
        <div style="margin-top:8px; font-weight:700;">플레이어</div>
        <div>공격 성공: ${stats.player.attacksHit}회</div>
        <div>공격 반사(W): ${stats.player.blocks}회</div>
        <div>체력 회복: ${stats.player.heals}회</div>
        <div style="margin-top:12px; font-weight:700;">AI</div>
        <div>공격 성공: ${stats.ai.attacksHit}회</div>
        <div>공격 반사(W): ${stats.ai.blocks}회</div>
        <div>체력 회복: ${stats.ai.heals}회</div>
    `;
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '닫기';
    closeBtn.style.marginTop = '16px';
    closeBtn.style.padding = '8px 16px';
    closeBtn.style.borderRadius = '999px';
    closeBtn.style.border = '1px solid rgba(255,255,255,0.2)';
    closeBtn.style.background = 'rgba(255,255,255,0.06)';
    closeBtn.style.color = '#f5f5f5';
    closeBtn.style.cursor = 'pointer';
    closeBtn.addEventListener('click', () => container.remove());

    panel.appendChild(title);
    panel.appendChild(winner);
    panel.appendChild(detail);
    panel.appendChild(closeBtn);
    container.appendChild(panel);

    const frame = $('#game-frame') || document.body;
    frame.appendChild(container);
}

// -------------------------------
// 규칙 기반 AI (쉬움)
// -------------------------------
function buildEasyAIAction(coreGame, dt) {
    const state = coreGame.getRenderState();
    const self = state.ai;
    const enemy = state.player;
    if (!self?.alive || !enemy?.alive) return zeroAction();

    const dx = enemy.pos.x - self.pos.x;
    const dy = enemy.pos.y - self.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    
    const action = zeroAction();

    // 일정 간격으로 일반 공격
    easyAIShootTimer -= dt;
    if (easyAIShootTimer <= 0) {
        action.shoot = true;
        easyAIShootTimer = 0.4;
    }

    // 너무 가까우면 뒤로 빠지고, 멀리 있으면 적 쪽으로 천천히 이동
    const desiredRange = 0.45 * GAME_CONFIG.width;
    if (dist < desiredRange * 0.7) {
        action.moveX = -dx / dist;
        action.moveY = -dy / dist;
    } else if (dist > desiredRange * 1.3) {
        action.moveX = dx / dist;
        action.moveY = dy / dist * 0.3;
    }

    if (Math.random() < 0.002) action.useQ = true;
    if (Math.random() < 0.002) action.useE = true;
    if (Math.random() < 0.001) action.useW = true;  

    return action;
}

function buildRuleBaseAction(coreGame, side, level = 'normal') {
    const state = coreGame.getRenderState();
    const self = side === 'ai' ? state.ai : state.player;
    const enemy = side == 'ai' ? state.player : state.ai;

    if (!self?.alive || !enemy?.alive) {
        return { 
            moveX: 0, moveY: 0, shoot: false,
            useQ: false, useW: false, useE: false, 
            useR: false, useD: false, useF: false,
        }
    }

    const dx = enemy.pos.x - self.pos.x;
    const dy = enemy.pos.y - self.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    const ux = dx / dist;
    const uy = dy / dist;

    const cd = self.skill?.getCooldownStatus?.() ?? {};
    const can = {
        Q: (cd.Q ?? 0) <= 0.0001,
        W: (cd.W ?? 0) <= 0.0001,
        E: (cd.E ?? 0) <= 0.0001,
        R: (cd.R ?? 0) <= 0.0001,
        D: (cd.D ?? 0) <= 0.0001,
        F: (cd.F ?? 0) <= 0.0001,
    };

    const action = zeroAction();
    action.dirX = dx; // E/R 조준용
    action.dirY = dy;

    // 이동(거리대별)
    /*
        너무 가까움(near): 적의 공격/스킬 사거리 안에 들어가서 위험하니 뒤로/비껴가기 쪽으로 이동하게 함
        너무 멂(far): 내 공격이 안 닿으니 앞으로 접근하게 함
        중간거리: 공격 확률이 가장 애매한 구간이라 정면 싸움보다 strafe(옆으로 비켜 이동) 같은 방식이 생존/명중에 유리할 때가 많음
    */
    const nearDist = level === 'normal' ? 260 : 300;
    const farDist = level === 'normal' ? 720 : 800;

    let mvx = 0;
    let mvy = 0;

    if (dist < nearDist) {
        mvx = -ux;
        mvy = -uy;
    } else if (dist > farDist) {
        mvx = ux;
        mvy = uy;
    } else {
        const px = -uy;
        const py = ux;
        const strafe = level === 'normal' ? 0.75 : 0.2;
        mvx = ux * (1 - strafe) + px * strafe;
        mvy = uy * (1 - strafe) + py * strafe;
    }

    action.moveX = Math.max(-1, Math.min(1, mvx));
    action.moveY = Math.max(-1, Math.min(1, mvy));

    // 기본 사격
    const inRange = dist < GAME_CONFIG.rangeGeneral;
    action.shoot = Math.random() < (inRange ? (level === 'normal' ? 0.85 : 0.5) : 0.2);

    // Q
    if (can.Q && dist < GAME_CONFIG.rangeHoming * 0.95 && dist > 180) {
        action.useQ = Math.random() < (level === 'normal' ? 0.1 : 0.06);
    }

    // E
    if (can.E && dist < GAME_CONFIG.rangeStun && dist > 160) {
        action.useE = Math.random() < (level === 'normal' ? 0.09 : 0.05);
    }
    // R
    const rMax = GAME_CONFIG.rangeGeneral + GAME_CONFIG.rangeTrailExtra;
    if (can.R && dist < rMax && dist > 220) {
        action.useR = Math.random() < (level === 'normal' ? 0.07 : 0.04);
    }
    // D: 스턴 시 해제 시도
    if (can.D && typeof self.isStunned === 'function' && self.isStunned(coreGame.time)) {
        action.useD = true;
    }
    // F: 너무 가까울 때 탈출기
    if (can.F && dist < 240) {
        action.useF = Math.random() < 0.25;
    }
    // W: 낮은 확률 사용(정교한 탄환 판정은 생략)
    if (can.W) {
        action.useW = Math.random() < (level === 'normal' ? 0.04 : 0.02);
    }
    return action;
}

// ============================================================
// TF.js / PPO 추론
// ============================================================
async function ensureTfjsLoaded() {
    if (tfLib) return tfLib;
    if (tfLoadPromise) return tfLoadPromise;

    // Promise 생성: 비동기 작업(다운로드)의 성공(resolve) 또는 실패(reject)를 관리
    tfLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        // 다운로드할 주소
        script.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
        // async = true: 게임의 다른 로직을 멈추지 않고 배경에서 조용히 다운로드
        script.async = true;
        // 성공 시(onload): 브라우저 전역 객체인 'window.tf'를 넘겨주며 준비 됐음을 알림
        script.onload = () => resolve(window.tf);
        // 실패 시(onerror)
        script.onerror = () => reject(new Error('tfjs load failed'));
        document.head.appendChild(script);
    });

    tfLib = await tfLoadPromise;
    return tfLib;
}

async function loadPolicyModel(policy) {
    await ensureTfjsLoaded();

    if (policy === 'hard') {
        if (hardPolicyModel) return hardPolicyModel;
        if (hardPolicyLoadPromise) return hardPolicyLoadPromise;

        hardPolicyLoadPromise = tfLib.loadLayersModel(HARD_POLICY_TFJS_URL).then((m) => {
            hardPolicyModel = m;
            return m;
        });
        return hardPolicyLoadPromise;
    }

    if (policy === 'latest') {
        if (latestPolicyModel) return latestPolicyModel;
        if (latestPolicyLoadPromise) return latestPolicyLoadPromise;

        latestPolicyLoadPromise = tfLib.loadLayersModel(LATEST_POLICY_TFJS_URL).then((m) => {
            latestPolicyModel = m;
            return m;
        });
        return latestPolicyLoadPromise;
    }
    throw new Error(`unknown policy: ${policy}`);
}

function flattenObsForPPO(obs) {
    const s = obs.self || {};
    const e = obs.enemy || {};
    const scd = s.cd || {};
    const ecd = e.cd || {};

    const vec = [];

    // time
    vec.push(Math.tanh((obs.time ?? 0) / 120));
    // self 10
    vec.push(s.x ?? 0, s.y ?? 0, s.hp ?? 0, clamp01((s.multiShot ?? 0) / 3));
    vec.push(clamp01((scd.Q ?? 0) / CD_MAX.Q));
    vec.push(clamp01((scd.W ?? 0) / CD_MAX.W));
    vec.push(clamp01((scd.E ?? 0) / CD_MAX.E));
    vec.push(clamp01((scd.R ?? 0) / CD_MAX.R));
    vec.push(clamp01((scd.D ?? 0) / CD_MAX.D));
    vec.push(clamp01((scd.F ?? 0) / CD_MAX.F));
    // enemy 10
    vec.push(e.x ?? 0, e.y ?? 0, e.hp ?? 0, clamp01((e.multiShot ?? 0) / 3));
    vec.push(clamp01((ecd.Q ?? 0) / CD_MAX.Q));
    vec.push(clamp01((ecd.W ?? 0) / CD_MAX.W));
    vec.push(clamp01((ecd.E ?? 0) / CD_MAX.E));
    vec.push(clamp01((ecd.R ?? 0) / CD_MAX.R));
    vec.push(clamp01((ecd.D ?? 0) / CD_MAX.D));
    vec.push(clamp01((ecd.F ?? 0) / CD_MAX.F));
    
    // projectiles
    const ps = (obs.projectiles || []).slice(0, MAX_PROJECTILES);
    for (const p of ps) {
        vec.push(p.x ?? 0, p.y ?? 0, p.vx ?? 0, p.vy ?? 0);
        vec.push(p.owner === 'ai' ? 1 : 0, p.homing ? 1 : 0, p.stun ? 1 : 0);
    }
    for (let i = ps.length; i < MAX_PROJECTILES; i++) vec.push(0, 0, 0, 0, 0, 0, 0);

    // items
    const items = (obs.items || []).slice(0, MAX_ITEMS);
    for (const it of items) {
        const t = String(it.type || '').toLowerCase();
        vec.push(it.x ?? 0, it.y ?? 0, t.includes('hp') ? 1 : 0, (t.includes('multi') || t.includes('shot')) ? 1 : 0);
    }
    for (let i = items.length; i < MAX_ITEMS; i++) vec.push(0, 0, 0, 0);
    if (vec.length !== OBS_DIM) throw new Error(`obs dim mismatch: ${vec.length}`);
    return vec;
}

function actionFromLogits(logits, obs) {
    if (!Array.isArray(logits) || logits.length < ACTION_LOGITS_DIM) {
        throw new Error(`invalid logits length: ${logits?.length}`);
    }

    // off: 오프셋(offset) 인덱스, 
    // 각 행동 영역의 시작 인덱스를 추적하기 위해 사용 (현재 배열의 어디까지 읽었는지 기억하는 포인터)
    let off = 0; 

    // 내부 함수 head: d개의 숫자를 잘라내어 그중 가장 큰 값의 인덱스(argmax)를 반환
    const head = (d) => {
        const seg = logits.slice(off, off+d);
        off += d;
        return argmax(seg);
    };

    const moveXIdx = head(3);
    const moveYIdx = head(3);
    const shootIdx = head(2);
    const qIdx = head(2);
    const wIdx = head(2);
    const eIdx = head(2);
    const rIdx = head(2);
    const dIdx = head(2);
    const fIdx = head(2);

    const sx = (obs.self?.x ?? 0) * GAME_CONFIG.width;
    const sy = (obs.self?.y ?? 0) * GAME_CONFIG.height;
    const ex = (obs.enemy?.x ?? 0) * GAME_CONFIG.width;
    const ey = (obs.enemy?.y ?? 0) * GAME_CONFIG.height;

    return {
        moveX: moveXIdx - 1,
        moveY: moveYIdx - 1,
        shoot: shootIdx === 1,
        useQ: qIdx === 1,
        useW: wIdx === 1,
        useE: eIdx === 1,
        useR: rIdx === 1,
        useD: dIdx === 1,
        useF: fIdx === 1,
        dirX: ex - sx,
        dirY: ey - sy,
    };
}

// --------------------------------
//모델 준비와 전처리
// --------------------------------
async function ppoActionFromObs(obs, policy) {
    const model = await loadPolicyModel(policy);
    const x = flattenObsForPPO(obs);

    // 모델 추론 시 메모리 관리를 위해 tidy() 사용
    // tidy(): 자동으로 필요 없어진 메모리 해제
    const logits = tfLib.tidy(() => {
        const input = tfLib.tensor2d([x], [1, OBS_DIM], 'float32');
        const pred = model.predict(input);
        let t = pred;
        if (Array.isArray(pred)) t = pred[0]; // 배열인 경우 첫 번째 요소 추출
        if (t.rank === 2) t = t.squeeze();
        // 텐서(GPU)에 있는 데이터를 자바스크랩트 배열(RAM)로 복사한다.
        // 그 후 우리가 약속한 행동 개수만큼만 잘라낸다.
        // dataSync(): 텐서에 있는 데이터를 자바스크랩트 배열로 복사
        return Array.from(t.dataSync()).slice(0, ACTION_LOGITS_DIM);
    });

    return actionFromLogits(logits, obs);
}

async function getPolicyAction(coreGame, side, policy) {
    if (policy === 'rule') return buildRuleBaseAction(coreGame, side, 'hard');
    if (policy === 'hard' || policy === 'latest') {
        const obs = coreGame.getObservationFor(side);
        return await ppoActionFromObs(obs, policy);
    }
    throw new Error(`unknown policy: ${policy}`);
}

// ============================================================
// 게임 루프
// ============================================================
function stopCoreGameIfRunning() {
    running = false;
}

function stopArenaWatch() {
    arenaRunning = false;
    if (arenaRafId) cancelAnimationFrame(arenaRafId);
    arenaRafId = null;
}

// -------------------------------
// 게임 환경 시작 + 루프 돌리기
// -------------------------------
function startCoreGame(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer) {
    resetStats();
    // CoreGame 초기화 (플레이어 색 + 배경 인덱스)
    game.startGame(selectedDragonColor, selectedBgIndex);

    running = true;
    lastTimestamp = performance.now();
    
    // HP 기준값 초기화
    const renderState = game.core.getRenderState();
    prevHP.player = renderState.player?.hp ?? 0;
    prevHP.ai = renderState.ai?.hp ?? 0;

    // 첫 UI 초기 랜더
    updateUIOverlay(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer);

    // 게임 루프 시작
    requestAnimationFrame((ts) => 
        gameLoop(ts, playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer)
    );
}

/**
 * 매 프레임 호출되는 게임 루프.
 * - dt(초)를 계산
 * - 입력 → 플레이어 액션 생성
 * - AI 액션(간단한 더미 또는 이후 교체 가능)
 * - CoreGame.step() 호출
 * - Game.draw()로 렌더링
 * - UI 오버레이(HP/쿨타임) 업데이트
 */
async function gameLoop(timestamp, playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer) {
    if (!running || !game) return;

    const dtMs = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    // dt를 초 단위로 변환 (너무 큰 값이면 상한 제한)
    let dt = dtMs / 1000;
    if (dt > 0.05) dt = 0.05; // 20fps 제한

    // 플레이어 액션: 마우스/키보드
    const actionPlayer = game.buildPlayerActionFromInput(dt);

    // AI 액션
    let actionAI = zeroAction();

    if (difficulty === 'easy') {
        actionAI = buildRuleBaseAction(game.core, 'ai', 'easy');
    } else if (difficulty === 'normal') {
        actionAI = buildRuleBaseAction(game.core, 'ai', 'normal');
    } else {
        const obs = game.core.getObservationFor('ai');
        actionAI = await ppoActionFromObs(obs, 'hard');
    }

    // 환경 한 스텝 진행
    const result = game.core.step(actionPlayer, actionAI, dt);

    // 통계 갱신
    accumulateStatsFromStep(game.core, result);
    
    // 랜더링
    game.draw();
    // 하단 UI(HP/쿨타임) 업데이트
    updateUIOverlay(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer);

    // 종료 체크
    if (result.done || game.isDone()) {
        running = false;
        showResultOverlay(result);
        return;
    }

    // 다음 프레임 예약
    requestAnimationFrame((ts) =>
        gameLoop(ts, playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer)
    );
}

function arenaLoop(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer,
    arenaSpeedEl, arenaPolicyAEl, arenaPolicyBEl, arenaStatusEl) {
    if (!arenaRunning || !game) return;

    let dt = (performance.now() - arenaLastTimestamp) / 1000;
    arenaLastTimestamp = performance.now();
    if (dt > 0.05) dt = 0.05;

    const speedFactor = Number(arenaSpeedEl.value || '1');

    (async () => {
        for (let i = 0; i < speedFactor; i++) {
            const policyA = String(arenaPolicyAEl.value || 'rule');
            const policyB = String(arenaPolicyBEl.value || 'rule');

            const actionPlayer = await getPolicyAction(game.core, 'player', policyA);
            const actionAI = await getPolicyAction(game.core, 'ai', policyB);

            const result = game.core.step(actionPlayer, actionAI, dt);
            accumulateStatsFromStep(game.core, result);

            if (result.done || game.isDone()) {
                arenaRunning = false;
                showResultOverlay();
                return;
            }
        }

        if (arenaStatusEl) {
            arenaStatusEl.textContent = `running | A=${arenaPolicyAEl?.value ?? 'rule'} vs B=${arenaPolicyBEl?.value ?? 'rule'} | speed=${arenaSpeedEl?.value ?? '1'}x`;
        }

        game.draw();
        updateUIOverlay(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer);

        if (arenaRunning) {
            arenaRafId = requestAnimationFrame(() => 
                arenaLoop(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer,
                    arenaSpeedEl, arenaPolicyAEl, arenaPolicyBEl, arenaStatusEl)
            )
        }
    })().catch((err) => {
        console.error('arena loop error:', err);
        if (arenaStatusEl) arenaStatusEl.textContent = `error: ${String(err?.message || err)}`;
        stopArenaWatch();
    })
}

// -------------------------------
// UI 초기화
// -------------------------------
async function init() {
    const canvas = /** @type {HTMLCanvasElement} */ ($('#game-canvas'));
    const characterSelect = $('#character-select');
    const startButton = $('#start-game-btn');

    const uiOverlay = $('#ui-overlay');
    const playerHpContainer = $('#player-hp');
    const aiHpContainer = $('#ai-hp');
    const playerCdContainer = $('#player-cd');
    const aiCdContainer = $('#ai-cd');

    // 도움말 모달 관련
    const helpBtn = $('#help-btn');
    const helpModal = $('#help-modal');
    const helpClose = $('#help-close');
    const helpBackdrop = $('#help-backdrop');

    // Game 인스턴스 생성
    game = new Game(canvas, {assetBase: './assets/'});
    // 에셋 로드 (배경/드래곤/투사체/아이템)
    await game.loadAssets();

    // ---------------------------
    // 드래곤 선택 버튼 설정
    // ---------------------------
    const dragonButtons = $all('.dragon-option');
    dragonButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            // 전체에서 선택 클래스 제거
            dragonButtons.forEach((b) => b.classList.remove('selected'));
            // 현재 클릭한 버튼만 선택
            btn.classList.add('selected');

            // data-color="black" | "white"
            const color = btn.getAttribute('data-color');
            selectedDragonColor = color === 'black' ? 'black' : 'white';

            updateStartButtonState(startButton);
        });
    })

    // ---------------------------
    // 배경 선택 버튼 설정
    // ---------------------------
    const bgButtons = $all('.bg-option');
    bgButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            bgButtons.forEach((b) => b.classList.remove('selected'));
            btn.classList.add('selected');

            const indexStr = btn.getAttribute('data-bg-index') || '0';
            selectedBgIndex = Number(indexStr) || 0;

            updateStartButtonState(startButton);
        });
    });

    // ---------------------------
    // 난이도 선택
    // ---------------------------
    const difficultyButtons = $all('.difficulty-option');
    difficultyButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            difficultyButtons.forEach((b) => b.classList.remove('selected'));
            btn.classList.add('selected');
            const lv = btn.getAttribute('data-level');
            if (lv === 'easy' || lv === 'normal' || lv === 'hard') difficulty = lv;
        });
    });

    // ---------------------------
    // 도움말 모달 열기/닫기
    // ---------------------------
    if (helpBtn && helpModal && helpClose && helpBackdrop) {
        const openHelp = () => {
            helpModal.classList.remove('hidden');
            helpModal.removeAttribute('inert');
            helpModal.setAttribute('aria-hidden', 'false');
            helpClose.focus();
        };

        const closeHelp = () => {
            helpBtn.focus();
            helpModal.classList.add('hidden');
            helpModal.setAttribute('inert', '');
            helpModal.setAttribute('aria-hidden', 'true');
        };

        helpBtn.addEventListener('click', openHelp);
        helpClose.addEventListener('click', closeHelp);
        helpBackdrop.addEventListener('click', closeHelp);

        window.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !helpModal.classList.contains('hidden')) {
                closeHelp();
            }
        });
    }

    // ---------------------------
    // 시작 버튼 클릭 → 게임 시작
    // ---------------------------
    startButton.addEventListener('click', () => {
        if (!canStartGame()) return;

        stopArenaWatch();
        stopCoreGameIfRunning();

        characterSelect?.classList.add('hidden');

        // 상단 UI 오버레이 표시
        if (uiOverlay) {
            uiOverlay.hidden = false;
            uiOverlay.setAttribute('aria-hidden', 'false');
        }

        // Game / CoreGame 초기화
        startCoreGame(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer);
    });

    // -------------------------------
    // arena-panel 버튼 연결 (Self-Play Arena Watch Only)
    // -------------------------------
    const arenaPanel = $('#arena-panel');
    const arenaTitle = arenaPanel ? arenaPanel.querySelector('h3') : null;

    const arenaStartBtn = $('#arenaStartBtn');
    const arenaStopBtn = $('#arenaStopBtn');
    const arenaResetBtn = $('#arenaResetBtn');

    const arenaSpeedEl = $('#arenaSpeed');

    const arenaPolicyAEl = $('#arenaPolicyA');
    const arenaPolicyBEl = $('#arenaPolicyB');
    const arenaStatusEl = $('#arenaStatus');

    if (arenaPolicyAEl) arenaPolicyAEl.disabled = false;
    if (arenaPolicyBEl) arenaPolicyBEl.disabled = false;

    const startArena = async () => {
        stopArenaWatch();
        stopCoreGameIfRunning();

        if (characterSelect) characterSelect.classList.add('hidden');

        if (uiOverlay) {
            uiOverlay.hidden = false;
            uiOverlay.setAttribute('aria-hidden', 'false');
        }

        const policyA = String(arenaPolicyAEl?.value || 'rule');
        const policyB = String(arenaPolicyBEl?.value || 'rule');

         // hard/latest 선택 시 실제 모델 로딩 확인
        try {
            if (arenaStatusEl) arenaStatusEl.textContent = 'loading models if needed...';
            if (policyA === 'hard' || policyA === 'latest') await loadPolicyModel(policyA);
            if (policyB === 'hard' || policyB === 'latest') await loadPolicyModel(policyB);
        } catch (e) {
            if (arenaStatusEl) arenaStatusEl.textContent = `model load failed: ${String(e?.message || e)}`;
            return;
        }

        resetStats();

        // selected 정보고 앖으면 black/0 기본값 사용(가짜 더미 아님: UI를 통해 들어오지 않는 경우 방어)
        const color = selectedDragonColor ?? 'black';
        const bgIndex = selectedBgIndex ?? 0;
        game.startGame(color, bgIndex);

        // 첫 렌더
        const renderState = game.core.getRenderState();
        prevHP.player = renderState.player?.hp ?? 0;
        prevHP.ai = renderState.ai?.hp ?? 0;

        game.draw();
        updateUIOverlay(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer);

        arenaRunning = true;
        arenaLastTimestamp = performance.now();

        arenaRafId = requestAnimationFrame(() => arenaLoop(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer, arenaSpeedEl));
    };

    const stopArena = () => {
        stopArenaWatch();
        // 원래 UI로 복귀
        if (arenaStatusEl) arenaStatusEl.textContent = 'idle';
        if (characterSelect) characterSelect.classList.remove('hidden');
        if (uiOverlay) uiOverlay.hidden = true
    };

    // 제목 클릭 / Start 버튼 클릭 둘 다 시작 가능
    arenaTitle?.addEventListener('click', startArena);
    arenaStartBtn?.addEventListener('click', startArena);
    arenaStopBtn?.addEventListener('click', stopArena);
    arenaResetBtn?.addEventListener('click', startArena);

    updateStartButtonState(startButton);
}

// -------------------------------
// DOMContentLoaded → init
// -------------------------------
window.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
        console.error('초기화 중 오류 발생:', err);
    });
});