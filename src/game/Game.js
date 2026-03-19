// ============================================================
// Game.js - 렌더링 및 입력 매핑
// ============================================================
// 역할:
// 논리(1920×1080)와 캔버스(1920×1080)가 같으므로 scale=1, offset=0.
// - 배경 / 드래곤 / 투사체(kind별 스프라이트) / 아이템 그리기.
// - buildPlayerActionFromInput(): Input → CoreGame 액션 형식 변환.
// - getUIState(): 오버레이 UI(HP, 쿨타임)용 상태 반환.
// ============================================================
import { GAME_CONFIG } from './config.js';
import { CoreGame } from '../core/CoreGame.js';
import { Input } from './Input.js';
import { ItemType } from './Item.js';

// ----------------------------------------
// 에셋 파일 경로 (배경, 드래곤, 투사체, 아이템)
// ----------------------------------------
const ASSET_PATHS = {
    // 배경: 인덱스 0~2 (3개)
    bg: ['bg_1.webP', 'bg_2.webP', 'bg_3.webP'],
    // 드래곤: 정면(f) / 등(b, R 스킬 투사체용)
    black_dragon_f: 'black_dragon_f.webP',
    black_dragon_b: 'black_dragon_b.webP',
    white_dragon_f: 'white_dragon_f.webP',
    white_dragon_b: 'white_dragon_b.webP',
    // 투사체: 검은(푸른 불꽃) / 하얀(붉은 불꽃)
    gen_b: 'gen_b.webP',
    gen_w: 'gen_w.webP',
    homing_b: 'homing_b.webP',
    homing_w: 'homing_w.webP',
    stun_b: 'stun_b.webP',
    stun_w: 'stun_w.webP',
    // W 반사 이펙트
    reflect_b: 'reflect_b.webP',
    reflect_w: 'reflect_w.webP',
    // 아이템
    power_up: 'power_up.webP',
    hp_up: 'hp_up.webP',
    // R 장판
    area_b: 'area_b.webP',
    area_w: 'area_w.webP',
}

async function loadImage(basePath, pathOrPaths) {
    const paths = Array.isArray(pathOrPaths) ? pathOrPaths : [pathOrPaths];
    const imgs = await Promise.all(
        paths.map((p) => {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error(`Failed to load image: ${basePath}${p}`));
                img.src = basePath + p;
            });
        })
    );
    return imgs.length === 1 ? imgs[0] : imgs;
}

export class Game {
    constructor(canvas, options) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.assetBase = options.assetBase || './assets/';

        // 환경 로직
        this.core = new CoreGame();
        // 마우스/키보드 입력
        this.input = new Input(canvas);
        // 스프라이트 이미지 로드
        this.sprites = {};
        this.bgIndex = 0;
        this.playerColor = 'black';
        this.moveTarget = null;
        // Q/E/R 키 홀드 상태 추적용
        this.skillKeyState = {
            E: { down: false, heldTime: 0 },
            R: { down: false, heldTime: 0 },
        };

        this.lastMouseDir = { x:  1, y: 0 }; // 기본 방향 (오른쪽)

        this.logicalWidth = GAME_CONFIG.width;
        this.logicalHeight = GAME_CONFIG.height;

        this.canvasWidth = canvas.width;
        this.canvasHeight = canvas.height;

        this._updateViewport();
    }

    // 캔버스 크기 변경 시 호출
    _updateViewport() {
        this.scale = 1;
        this.viewportWidth = this.logicalWidth * this.scale;
        this.viewportHeight = this.logicalHeight * this.scale;

        this.offsetX = (this.canvasWidth - this.viewportWidth) / 2;
        this.offsetY = (this.canvasHeight - this.viewportHeight) / 2;
    }

    async loadAssets() {
        const base = this.assetBase;

        const bgImgs = await loadImage(base, ASSET_PATHS.bg);
        ASSET_PATHS.bg.forEach((_, i) => {
            this.sprites[`bg_${i}`] = bgImgs[i];            
        });

        // 드래곤 4장 (정면 f, 등 b)
        this.sprites.black_dragon_f = await loadImage(base, ASSET_PATHS.black_dragon_f);
        this.sprites.black_dragon_b = await loadImage(base, ASSET_PATHS.black_dragon_b);
        this.sprites.white_dragon_f = await loadImage(base, ASSET_PATHS.white_dragon_f);
        this.sprites.white_dragon_b = await loadImage(base, ASSET_PATHS.white_dragon_b);

        // 투사체 6장 (기본/유도/스턴 × 검은/하얀)
        this.sprites.gen_b = await loadImage(base, ASSET_PATHS.gen_b);
        this.sprites.gen_w = await loadImage(base, ASSET_PATHS.gen_w);
        this.sprites.homing_b = await loadImage(base, ASSET_PATHS.homing_b);
        this.sprites.homing_w = await loadImage(base, ASSET_PATHS.homing_w);
        this.sprites.stun_b = await loadImage(base, ASSET_PATHS.stun_b);
        this.sprites.stun_w = await loadImage(base, ASSET_PATHS.stun_w);

        // W 반사 이펙트 2장
        this.sprites.reflect_b = await loadImage(base, ASSET_PATHS.reflect_b);
        this.sprites.reflect_w = await loadImage(base, ASSET_PATHS.reflect_w);

        // R 장판 2장
        this.sprites.area_b = await loadImage(base, ASSET_PATHS.area_b);
        this.sprites.area_w = await loadImage(base, ASSET_PATHS.area_w);

        try {
            this.sprites.power_up = await loadImage(base, ASSET_PATHS.power_up);
            this.sprites.hp_up = await loadImage(base, ASSET_PATHS.hp_up);
        } catch (e) {
            console.warn('아이템 스프라이트 로드 실패:', e);
        }
    }

    startGame(playerColor = 'black', bgIndex = 0) {
        this.playerColor = playerColor;

        const maxBgIndex = ASSET_PATHS.bg.length - 1;
        this.bgIndex = Math.max(0, Math.min(maxBgIndex, bgIndex));

        this.moveTarget = null;

        const obs = this.core.reset({ playerColor });

        // 드래곤 스프라이트 설정
        const playerF = this.playerColor === 'black' ? this.sprites.black_dragon_f : this.sprites.white_dragon_f;
        const aiF = this.playerColor === 'black' ? this.sprites.white_dragon_f : this.sprites.black_dragon_f;
        if (this.core.player) this.core.player.sprite = playerF;
        if (this.core.ai) this.core.ai.sprite = aiF;

        // W 반사 스프라이트 설정
        if (this.core.player) {
            const isBlack = this.core.player.color === '#5bc5ff';
            this.core.player.reflectSprite = isBlack ? this.sprites.reflect_b : this.sprites.reflect_w;
        }
        if (this.core.ai) {
            const isBlack = this.core.ai.color === '#5bc5ff';
            this.core.ai.reflectSprite = isBlack ? this.sprites.reflect_b : this.sprites.reflect_w;
        }

        return obs;
    }

     /**
     * Input 상태를 CoreGame.step()에 넣을 플레이어 액션으로 변환.
     * - 우클릭: 이동 목표 설정 → 매 프레임 목표 방향으로 moveX/moveY
     * - 좌클릭 유지: shoot
     * - W/Q/E/R/D/F: useW, useQ, useE, useR, useD, useF
     */
    buildPlayerActionFromInput(dt) {
        const action = {
            moveX: 0,
            moveY: 0,
            shoot: false,
            useW: false,
            useQ: false,
            useE: false,
            useR: false,
            useD: false,
            useF: false,

            dirX: 0,
            dirY: 0,
        };

        const player = this.core.player;
        const ai = this.core.ai;
        if (!player?.alive) return action;

        const aimMode = this.input.isKeyDown('a');

        // 우클릭: 이동 목표 설정 → 매 프레임 목표 방향으로 moveX/moveY
        const rightPos = this.input.consumeRightClick();

        if (!aimMode) {
            if (rightPos) {
                this.moveTarget = this._screenToLogical(rightPos);
            }
        }

        // 이동: 목표까지 방향 벡터
        if (this.moveTarget) {
            const dx = this.moveTarget.x - player.pos.x;
            const dy = this.moveTarget.y - player.pos.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 1e-3) {
                action.moveX = dx / len;
                action.moveY = dy / len;
            }
            if (len < 50) this.moveTarget = null;
        } else {
            this.moveTarget = null;
            action.moveX = 0;
            action.moveY = 0;
        }

        // 기본 공격(발사) 처리
        if (aimMode) {
            if (rightPos && ai?.alive) {
                const dx = ai.pos.x - player.pos.x;
                const dy = ai.pos.y - player.pos.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len <= GAME_CONFIG.rangeGeneral) {
                    action.shoot = true;
                }
            }
        }

        const mouse = this.input.mousePos;
        const dx = mouse.x - player.pos.x;
        const dy = mouse.y - player.pos.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 1e-3) {
            action.dirX = dx / len;
            action.dirY = dy / len;
            this.lastMouseDir.x = action.dirX;
            this.lastMouseDir.y = action.dirY;
        } else {
            action.dirX = this.lastMouseDir.x;
            action.dirY = this.lastMouseDir.y;
        }

        action.shoot = this.input.leftDown;

        // Q/E/R 키 상태 업데이트
        this._updateSkillKeyState(dt);

        const eState = this.skillKeyState.E;
        const rState = this.skillKeyState.R;

        if (this.input.consumeKey('q')) action.useQ = true;
        if (this.input.consumeKey('w')) action.useW = true;
        if (this.input.consumeKey('d')) action.useD = true;
        if (this.input.consumeKey('f')) action.useF = true;

        // Q/E/R는 “떼는 순간”에만 발동
        const MIN_HOLD = 0.05; // 최소 누르고 있는 시간 (0.05초)

        if (eState.justReleased && eState.heldTime >= MIN_HOLD) {
            action.useE = true;
            eState.heldTime = 0;
            eState.justReleased = false;
        }
        if (rState.justReleased && rState.heldTime >= MIN_HOLD) {
            action.useR = true;
            rState.heldTime = 0;
            rState.justReleased = false;
        }

        return action;
    }

    // 브라우저 좌표(mouse event)를 로직 좌표계로 반환 (리사이즈 대응)
    _screenToLogical(pos) {
        const x = (pos.x - this.offsetX) / this.scale;
        const y = (pos.y - this.offsetY) / this.scale;
        return {
            x: Math.max(0, Math.min(this.logicalWidth, x)),
            y: Math.max(0, Math.min(this.logicalHeight, y)),
        };
    }

    getUIState() {
        const state = this.core.getRenderState();
        const player = state.player;
        const ai = state.ai;
        return {
            playerHP: player?.hp ?? 0,
            playerHPMax: GAME_CONFIG.playerHPMAX,
            aiHP: ai?.hp,
            aiHPMax: GAME_CONFIG.playerHPMAX,
            playerCd: player?.skill?.getCooldownStatus(),
            aiCd: ai?.skill?.getCooldownStatus(),
        };
    }

    draw() {
        const ctx = this.ctx;
        const state = this.core.getRenderState();

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

        // 배경: 게임 뷰포트 영역에만 배경 이미지
        const bg = this.sprites[`bg_${this.bgIndex}`];
        if (bg && bg.complete) {
            ctx.drawImage(bg, this.offsetX, this.offsetY, this.viewportWidth, this.viewportHeight);
        } else {
            ctx.fillStyle = '#0a0a12';
            ctx.fillRect(this.offsetX, this.offsetY, this.viewportWidth, this.viewportHeight);
        }

        // 논리 좌표계로 변환 (게임 영역만 그리기)
        ctx.save();
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        // 아이템 그리기
        for (const it of state.items) {
            if (!it.alive) continue;
            const sprite = it.type === ItemType.MULTI_SHOT ? this.sprites.power_up : this.sprites.hp_up;
            if (sprite) it.sprite = sprite;
            it.draw(ctx);
        }

        // 투사체 그리기 (kind별 스프라이트 주입 후 draw)
        for (const p of state.projectiles) {
            if (!p.alive) continue;
            this._injectProjectileSprite(p);
            p.draw(ctx);
        }

        // R 장판 렌더링
        for (const z of state.trailZones || []) {
            if (!z) continue;
            if (z.expireAt < state.time) continue; // 이미 만료면 그리지 않음

            // 잔상 지속 시간 비율(0~1) -> 알파/글로우 fade
            const duration = GAME_CONFIG.skillDurations.R || 1.0;
            const t = Math.max(0, Math.min(1, (z.expireAt - state.time) / duration));

            const alpha = 0.15 + 0.35 * t; // 
            const glow = 10 + 30 * t;

            const isBlack = z.color === '#5bc5ff';
            const areaImg = isBlack ? this.sprites.area_b : this.sprites.area_w;

            // z.dir(전방 단위 벡터) 기준 회전
            const angle = Math.atan2(z.dir.y, z.dir.x);
            
            // 캔버스에서 x=0 시작 형태로 직사각형 그림
            const y = -z.thickness / 2;

            ctx.save();
            ctx.translate(z.origin.x, z.origin.y);
            ctx.rotate(angle);

            ctx.globalAlpha = alpha;

            if(areaImg && areaImg.complete) {
                ctx.drawImage(areaImg, 0, y, z.length, z.thickness);
            }

            ctx.restore();
        }

        // 드래곤 그리기
        if (state.player?.alive) state.player.draw(ctx);
        if (state.ai?.alive) state.ai.draw(ctx);

        // ======================================================
        // 공격/스킬 사거리 미리보기 (플레이어만)
        // - 기본 공격: 마우스 좌클릭 꾹 → 원형 사거리
        // - Q/E/R: 키를 꾹 누르고 있는 동안 해당 스킬 사거리 표시
        // ======================================================
        if (state.player?.alive) {
            const p = state.player;
            const aimMode = this.input.isKeyDown('a');
            const cd = p.skill?.getCooldownStatus();

            const mouse = this.input.mousePos;
            const worldMouse = this._screenToLogical(mouse);
            const dx = worldMouse.x - p.pos.x;
            const dy = worldMouse.y - p.pos.y;
            const len = Math.sqrt(dx * dx + dy * dy);
            const angle = Math.atan2(dy, dx);

            ctx.save();
            ctx.translate(p.pos.x, p.pos.y)

            if (aimMode) {
                // 기본 공격 사거리
                if (this.input.leftDown) {
                    ctx.strokeStyle = 'rgba(80, 200, 255, 0.5)';
                    ctx.lineWidth = 3;
                    ctx.setLineDash([8, 6]);
                    ctx.beginPath();
                    ctx.arc(0, 0, GAME_CONFIG.rangeGeneral, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }
            }

            // Q – 유도탄 사거리 (Q 키 꾹)
            if (cd.Q <= 0 && this.input.isKeyDown('q')) {
                ctx.strokeStyle = 'rgba(80, 200, 255, 0.5)';
                ctx.lineWidth = 2;
                ctx.setLineDash([6, 4]);
                ctx.beginPath();
                ctx.arc(0, 0, GAME_CONFIG.rangeHoming, 0, Math.PI * 2);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // E – 스턴탄 사거리 (E 키 꾹)
            if (cd.E <= 0 && this.input.isKeyDown('e')) {
                const lenE = GAME_CONFIG.rangeStun;
                const thE = GAME_CONFIG.trailThickness * 0.7;

                ctx.save();
                ctx.rotate(angle);
                ctx.fillStyle = 'rgba(255, 200, 120, 0.18)';
                ctx.strokeStyle = 'rgba(255, 220, 150, 0.8)';
                ctx.lineWidth = 2;

                const x = 0;
                const y = -thE / 2;

                ctx.beginPath();
                ctx.rect(x, y, lenE, thE);
                ctx.fill();
                ctx.stroke();
            }

            // R – 잔상 사거리 (R 키 꾹)
            if (cd.R <= 0 && this.input.isKeyDown('r')) {
                const length = GAME_CONFIG.rangeGeneral + GAME_CONFIG.rangeTrailExtra;
                const thickness = GAME_CONFIG.trailThickness * 1.5;
                ctx.rotate((p.facing || 0) + Math.PI * 2);
                ctx.fillStyle = 'rgba(255, 80, 80, 0.18)';
                ctx.strokeStyle = 'rgba(255, 120, 80, 0.7)';
                ctx.lineWidth = 3;
                const x = 0;
                const y = -thickness / 2;
                ctx.beginPath();
                ctx.rect(x, y, length, thickness);
                ctx.fill();
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    _injectProjectileSprite(p) {
        const isBlack = p.color === '#5bc5ff';
        if (p.kind === 'GEN') {
            p.sprite = isBlack ? this.sprites.gen_b : this.sprites.gen_w;
        } else if (p.kind === 'HOMING') {
            p.sprite = isBlack ? this.sprites.homing_b : this.sprites.homing_w;
        } else if (p.kind === 'STUN') {
            p.sprite = isBlack ? this.sprites.stun_b : this.sprites.stun_w;
        } else if (p.kind === 'TRAIL') {
            p.sprite = isBlack ? this.sprites.black_dragon_b : this.sprites.white_dragon_b;
        }
    }

    /**
    * Q/E/R 키를 “누르고 있는 동안”과 “떼는 순간”을 구분해서
    * - heldTime: 누르고 있던 시간
    * - justReleased: 이번 프레임에 뗐는지 여부
    */
   _updateSkillKeyState(dt) {
    const map = this.skillKeyState;
    const keys = ['E', 'R'];

    keys.forEach((k) => {
        const notDown = this.input.isKeyDown(k); // 현재 눌려있는지
        const st = map[k];

        if (notDown) {
            // 누르고 있는 동안 시간 누적
            st.heldTime += dt;
        } else {
            //손을 뗀 순간인지 체크
            st.justReleased = st.down && !notDown;
        }

        st.down = notDown
    })
   }

    isDone() {
        return this.core.done;
    }
}