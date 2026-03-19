// ============================================================
// main.js - 엔트리 포인트
// ============================================================
// 역할:
// - index.html의 UI(드래곤 선택, 배경 선택, 시작 버튼, 도움말 모달, 상단 HP/쿨타임 바)를 모두 연결.
// - Game 클래스와 CoreGame 환경을 생성하고, requestAnimationFrame 루프로 게임을 실행.
// - Input → Game.buildPlayerActionFromInput() → CoreGame.step() → Game.draw() → UI 업데이트.
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
// DOM 요소 헬퍼
// -------------------------------
function $(selector) {
    return document.querySelector(selector);
}

function $all(selector) {
    return Array.from(document.querySelectorAll(selector));
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
    // AI 난이도 선택
    // ---------------------------
    const difficultyButtons = $all('.difficulty-option');
    difficultyButtons.forEach((btn) => {
        btn.addEventListener('click', () => {
            difficultyButtons.forEach((b) => b.classList.remove('selected'));
            btn.classList.add('selected');
            const level = btn.getAttribute('data-level');
            if (level === 'easy' || level === 'normal' || level === 'hard') {
            difficulty = level;
            }
            updateStartButtonState(startButton);
        });
    });

    // ---------------------------
    // 시작 버튼 클릭 → 게임 시작
    // ---------------------------
    startButton.addEventListener('click', () => {
        if (!canStartGame()) return;

        // 선택 UI 숨기기
        if (characterSelect) {
            characterSelect.classList.add('hidden');
        }

        // 상단 UI 오버레이 표시
        if (uiOverlay) {
            uiOverlay.hidden = false;
            uiOverlay.setAttribute('aria-hidden', 'false');
        }

        resetStats();

        game.startGame(selectedDragonColor, selectedBgIndex);

        // Game / CoreGame 초기화
        startCoreGame(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer);
    });

    try {
        await game.loadAssets();
    } catch (err) {
        console.error('에셋 로드 중 오류 발생:', err);
    }
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
function gameLoop(timestamp, playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer) {
    if (!running || !game) return;

    const dtMs = timestamp - lastTimestamp;
    lastTimestamp = timestamp;

    // dt를 초 단위로 변환 (너무 큰 값이면 상한 제한)
    let dt = dtMs / 1000;
    if (dt > 0.05) dt = 0.05; // 20fps 제한

    // 플레이어 액션: 마우스/키보드
    const actionPlayer = game.buildPlayerActionFromInput(dt);

    // AI 액션
    let actionAI;

    if (difficulty === 'easy') {
        actionAI = buildEasyAIAction(game.core, dt);
    } else if (difficulty === 'normal') {
        const obsAI = game.core.getObservationFor('ai');
        actionAI = policy(obsAI);
    } else {
        const obsAI = game.core.getObservationFor('ai');
        actionAI = policy(obsAI);
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
// 상단(이제는 하단) UI 오버레이 갱신
// -------------------------------
function updateUIOverlay(playerHpContainer, aiHpContainer, playerCdContainer, aiCdContainer) {
    if (!game) return;

    const ui = game.getUIState();
    const {
        playerHP,
        playerHPMax,
        aiHP,
        aiHPMax,
        playerCd = {},
        aiCd = {},
    } = ui;

    renderHpBar(playerHpContainer, playerHP, playerHPMax, true);
    renderHpBar(aiHpContainer, aiHP, aiHPMax, false);

    renderCooldowns(playerCdContainer, playerCd);
    renderCooldowns(aiCdContainer, aiCd);
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
// 규칙 기반 AI (쉬움)
// -------------------------------
function buildEasyAIAction(coreGame, dt) {
    const state = coreGame.getRenderState();
    const self = state.ai;
    const enemy = state.player;

    if (!self?.alive || !enemy?.alive) {
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

    const dx = enemy.pos.x - self.pos.x;
    const dy = enemy.pos.y - self.pos.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;

    const action = {
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

    const SHOOT_INTERVAL = 0.5;

    easyAIShootTimer -= dt;

    if (easyAIShootTimer <= 0) {
        action.shoot = true;
        easyAIShootTimer = SHOOT_INTERVAL;
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

    // 아주 가끔 Q, E 사용 (랜덤)
    if (Math.random() < 0.002) action.useQ = true;
    if (Math.random() < 0.002) action.useE = true;

    // W: 화면 가운데 근처에서 랜덤하게 한 번씩
    if (Math.random() < 0.001 && Math.abs(self.pos.x - GAME_CONFIG.width / 2) < 300) {
        action.useW = true;
    }

    return action;
}

// -------------------------------
// DOMContentLoaded → init
// -------------------------------
window.addEventListener('DOMContentLoaded', () => {
    init().catch((err) => {
        console.error('초기화 중 오류 발생:', err);
    });
});