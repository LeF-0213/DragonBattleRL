// ============================================================
// CoreGame.js
// ------------------------------------------------------------
// 강화학습 / AI / 인간 모두가 공통으로 사용하는
// "순수 게임 환경(Environment)" 로직.
//
// 난이도 설계:
// - 쉬움(Easy)   : 플레이어 = 인간, 상대 = 규칙기반 AI 정책
// - 보통(Normal) : 플레이어 = 인간, 상대 = 좀 더 센 규칙기반 AI 정책
// - 어려움(Hard) : self-play로 학습한 정책 기반 AI
// 
// Self-Play 학습을 위해 step이 양쪽 관점 obs/reward를 모두 반환:
// - obsPlayer, rewardPlayer : 하단 드래곤 입장
// - obsAI,     rewardAI     : 상단 드래곤 입장
//
// 제공 API:
//   - reset({ playerColor }):
//       에피소드 초기화, 초기 관측(기본: player 관점)을 리턴
//   - step(actionPlayer, actionAI, dt):
//       한 스텝 진행 후
//       {
//         obsPlayer, obsAI,
//         rewardPlayer, rewardAI,
//         done, info
//       } 리턴
//   - getObservationFor(side): 'player' | 'ai' 관점으로 관측 리턴
//   - getRenderState(): 렌더용 상태 (Game.js에서 draw에 사용)
// ============================================================
import { GAME_CONFIG } from '../game/config.js';
import { Vector2 } from '../game/Vector2.js';
import { Dragon } from '../game/Dragon.js';
import { Projectile, ProjectileOwner } from '../game/Projectile.js';
import { Item, ItemType } from '../game/Item.js';
// 브라우저 환경용: 값 v를 min~max로 제한 (React Native 의존성 제거)
function clamp(v, min, max) {
    return Math.max(min, Math.min(max, v));
}

export class CoreGame {
    constructor() {
        // 환경 시간(초)
        this.time = 0;

        // 플레이어 드래곤 색상 ('black' | 'white)
        this.playerColor = 'black';

        // 엔티티
        this.player = null;
        this.ai = null;
        this.projectiles = [];
        this.items = []

        // 아이템 스폰 타이머
        this.itemSpawnTimerPlayer = GAME_CONFIG.itemSpawnInterval;
        this.itemSpawnTimerAI = GAME_CONFIG.itemSpawnInterval * 0.5;

        // 에피소드 종료 플래그
        this.done = false;

        // 이벤트 로그 (보상 shaping/디버깅용)
        this.events = [];

        // 플레이어 Y 방향 속도 (AI/RL이 참고 가능)
        this.playerLastY = 0;
        this.playerVelocityY = 0;

        // 기본 공격 연사 제한용 (너무 과발사 방지)
        this.shootCdPlayer = 0;
        this.shootCdAI = 0;

        // R 장판 목록
        this.trailZones = [];
        this.trailZoneId = 0;
    }

    // ------------------------------------------------------------
    // reset(options)
    // - 새 에피소드 시작
    // - options.playerColor: 'black' | 'white' (기본 'black')
    // - 리턴: 초기 observation
    // ------------------------------------------------------------
    reset(options = {}) {
        this.time = 0;
        this.done = false;
        this.events = [];

        this.projectiles = [];
        this.items = [];

        this.trailZones = [];
        this.trailZoneId = 0;

        this.itemSpawnTimerPlayer = GAME_CONFIG.itemSpawnInterval;
        this.itemSpawnTimerAI = GAME_CONFIG.itemSpawnInterval * 0.5;

        this.shootCdPlayer = 0;
        this.shootCdAI = 0;
        
        this.playerColor = options.playerColor || 'black';
        const isPlayerBlack = this.playerColor === 'black';

        const midX = GAME_CONFIG.width / 2;
        const midY = GAME_CONFIG.height / 2;

        // 플레이어(하단) 드래곤
        this.player = new Dragon({
        id: 'player',
        pos: new Vector2(GAME_CONFIG.width * 0.1, midY),
        // 색상은 "불꽃 킬러"로만 사용(렌더링/이펙트)
        color: isPlayerBlack ? '#5bc5ff' : '#ff6b6b',
        half: 'left',
        sprite: null,
        });

        // 상대(상단) 드래곤
        this.ai = new Dragon({
        id: 'ai',
        pos: new Vector2(GAME_CONFIG.width * 0.9, midY),
        color: isPlayerBlack ? '#ff6b6b' : '#5bc5ff',
        half: 'right',
        sprite: null,
        });

        this.playerLastY = this.player.pos.y;
        this.playerVelocityY = 0;

        return this.getObservationFor('player');
    }

    // ------------------------------------------------------------
    // step(actionPlayer, actionAI, dt)
    //
    // - actionPlayer: 하단 드래곤(플레이어 슬롯) 액션
    // - actionAI    : 상단 드래곤(두 번째 슬롯) 액션
    // - dt: 델타타임(초), 기본 1/60
    //
    // - 리턴: { obsPlayer, obsAI, rewardPlayer, rewardAI, done, info }
    // ------------------------------------------------------------
    step(actionPlayer, actionAI, dt = 1 / 60) {
        // 이미 끝난 에피소드면 상태만 유지
        if (this.done) {
            return {
                obsPlayer: this.getObservationFor('player'),
                obsAI: this.getObservationFor('ai'),
                rewardPlayer: 0,
                rewardAI: 0,
                done: true,
                info: { events: [] },
            };
        }

        const clampedDt = Math.min(dt, 1 / 30); // 너무 큰 dt 방지
        this.time += clampedDt;
        this.events = [];

        // 만료된 장판 제거(현재 time 기준)
        this.trailZones = this.trailZones.filter((z) => z.expireAt > this.time);

        // 장판 위 시전자 이동 속도 보너스
        this._updateTrailSpeedBonuses();

        // 기본 공격 연사 쿨다운 감소
        this.shootCdPlayer = Math.max(0, this.shootCdPlayer - clampedDt);
        this.shootCdAI = Math.max(0, this.shootCdAI - clampedDt);

        // 정화(D) 처리 (스턴 + 데미지 해제)
        if (actionPlayer?.useD) this.player.processDInput(this.time);
        if (actionAI?.useD) this.ai.processDInput(this.time);

        // 이동 (액션의 moveX/moveY → targetPos)
        this.applyMovementAction(this.player, actionPlayer, clampedDt);
        this.applyMovementAction(this.ai, actionAI, clampedDt);

        // 스킬 (Q/W/E/R)
        this.applySkillAction(this.player, this.ai, actionPlayer);
        this.applySkillAction(this.ai, this.player, actionAI);

        // 기본 공격 (shoot)
        if (actionPlayer?.shoot) this.tryShoot(this.player, this.ai.pos, 'player');
        if (actionAI?.shoot) this.tryShoot(this.ai, this.player.pos, 'ai');

        // 드래곤 상태 업데이트 (스킬 쿨/지속 + 실제 이동)
        this.player.update(clampedDt, this.time);
        this.ai.update(clampedDt, this.time);

        // 플레이어 Y 속도 추적
        this.playerVelocityY = (this.player.pos.y - this.playerLastY) / clampedDt;
        this.playerLastY = this.player.pos.y;

        // 투사체 업데이트
        for (const p of this.projectiles) p.update(clampedDt);
        this.projectiles = this.projectiles.filter((p) => p.alive);

        // 아이템 스폰 + 업데이트
        this.spawnItems(clampedDt);
        for (const it of this.items) it.update(clampedDt);
        this.items = this.items.filter((it) => it.alive);

        // 충돌 전 HP 기록 (보상 계산용)
        const prevPlayerHP = this.player.hp;
        const prevAIHP = this.ai.hp;

        // 충돌 처리(투사체/잔상/아이템)
        this.handleCollisions();

        // 보상 계산 (양쪽 관점)
        // player 관점:
        //   - 적 HP 감소: +
        //   - 내 HP 감소: -
        let rewardPlayer = 0;
        rewardPlayer += (prevAIHP - this.ai.hp);
        rewardPlayer -= (prevPlayerHP - this.player.hp);

        // ai 관점(대칭):
        //   - player HP 감소: +
        //   - ai HP 감소: -
        let rewardAI = 0;
        rewardAI += (prevPlayerHP - this.player.hp);
        rewardAI -= (prevAIHP - this.ai.hp);

        // 승패 보상: 양쪽에게 대칭 부여
        if (!this.player.alive || !this.ai.alive) {
            this.done = true;
            // player 승리
            if (this.player.alive && !this.ai.alive) {
                rewardPlayer += 10;
                rewardAI -= 10;
            } else if (!this.player.alive && this.ai.alive) {
                // ai 승리
                rewardPlayer -= 10;
                rewardAI += 10;
            }
        }

        return {
            obsPlayer: this.getObservationFor('player'),
            obsAI: this.getObservationFor('ai'),
            rewardPlayer,
            rewardAI,
            done: this.done,
            info: { events: this.events.slice() },
        }
    }

    // ------------------------------------------------------------
    // getObservationFor(side)
    // - side: 'player' 또는 'ai'
    // - 해당 입장에서 본 관측을 리턴
    //   (self: 나, enemy: 상대)
    // ------------------------------------------------------------
    getObservationFor(side = 'player') {
        const self = side === 'player' ? this.player : this.ai;
        const enemy = side === 'player' ? this.ai : this.player;

        return {
            time: this.time,

            self: {
                x: self.pos.x / GAME_CONFIG.width,
                y: self.pos.y / GAME_CONFIG.height,
                hp: self.hp / self.hpMax,
                multiShot: self.multiShotLevel,
                cd: self.skill.getCooldownStatus(),
            },
            
            enemy: {
                x: enemy.pos.x / GAME_CONFIG.width,
                y: enemy.pos.y / GAME_CONFIG.height,
                hp: enemy.hp / enemy.hpMax,
                multiShot: enemy.multiShotLevel,
                cd: enemy.skill.getCooldownStatus(),
            },

            // 투사체 요약
            projectiles: this.projectiles.map((p) => ({
                x: p.pos.x / GAME_CONFIG.width,
                y: p.pos.y / GAME_CONFIG.height,
                vx: (p.dir.x * p.speed) / GAME_CONFIG.projectileSpeed,
                vy: (p.dir.y * p.speed) / GAME_CONFIG.projectileSpeed,
                owner: p.owner,             // 'player' | 'ai'
                homing: p.homing ? 1 : 0,   // Q 유도 여부
                stun: p.stunOnHit ? 1 : 0,  // R 스턴 여부
            })),

            // 아이템 요약
            items: this.items.map((it) => ({
                x: it.pos.x / GAME_CONFIG.width,
                y: it.pos.y / GAME_CONFIG.height,
                type: it.type,
            })),

            stunned: self.isStunned(this.time) ? 1 : 0
        };
    }

    // ------------------------------------------------------------
    // getRenderState()
    // - Game.js에서 draw()할 때 쓰는 렌더용 상태
    // - 실제 객체(Dragon/Projectile/Item)를 그대로 넘긴다.
    // ------------------------------------------------------------  
    getRenderState() {
        return {
            time: this.time,
            player: this.player,
            ai: this.ai,
            projectiles: this.projectiles,
            items: this.items,
            trailZones: this.trailZones,
        };
    }

    // ------------------------------------------------------------
    // R 장판(고정 직사각형) 유틸
    // ------------------------------------------------------------
    _isPointInsideTrailZone(pos, zone) {
        // zone 좌표계에서 point를 투영:
        // - along: 전방(장판 길이 방향)으로 얼마나 진행했는지
        // - side: 좌우(장판 폭 방향)로 얼마나 벗어났는지
        const relX = pos.x - zone.origin.x;
        const relY = pos.y - zone.origin.y;

        const along = relX * zone.dir.x + relY * zone.dir.y;
        const side = relX * zone.n.x + relY * zone.n.y;

        return (
            along >= 0 &&
            along <= zone.length &&
            side >= -zone.halfThickness &&
            side <= zone.halfThickness
        );
    }

    // ------------------------------------------------------------
    // R 장판 위 시전자 이동 속도 보너스
    // ------------------------------------------------------------
    _updateTrailSpeedBonuses() {
        // 기본값(평지)
        if (this.player) this.player.trailSpeedMultipier = 1.0;
        if (this.ai) this.ai.trailSpeedMultipier = 1.0;

        if (!this.trailZones?.length) return;

        // 여러 장판이 겹칠 수 있으니 "최댓값" 방영 (이 게임에서는 겹칠일 없긴 함)
        for (const z of this.trailZones) {
            if (!z) continue;
            if (z.expireAt < this.time) continue;

            // 시전자 장판 위에 있으면 이동속도 증가
            if (z.ownerId === 'player' && this.player?.alive) {
                const inside = this._isPointInsideTrailZone(this.player.pos, z);
                if (inside) {
                    this.player.trailSpeedMultipier = Math.max(
                        this.player.trailSpeedMultipier,
                        GAME_CONFIG.trailSpeedMultiplier,
                    );
                }
            }

            if (z.ownerId === 'ai' && this.ai?.alive) {
                const inside = this._isPointInsideTrailZone(this.ai.pos, z);
                if (inside) {
                    this.ai.trailSpeedMultipier = Math.max(
                        this.ai.trailSpeedMultipier,
                        GAME_CONFIG.trailSpeedMultiplier,
                    );
                }
            }
        }
    }

    // R 장판 위 적 둔화 처리
    // - 진입(inside: false => true) 순간 1회만 적용하기 위해 inside 플래그를 저장한다.
    _applyTrailZoneEffects() {
        if (!this.trailZones?.length) return;

        for (const z of this.trailZones) {
            if (!z) continue;
            if (z.expireAt < this.time) continue;

            const insidePlayer = this.player?.alive
                ? this._isPointInsideTrailZone(this.player.pos, z)
                : false;

            const insideAI = this.ai?.alive
                ? this._isPointInsideTrailZone(this.ai.pos, z)
                : false;

            // zone owner(시전자) 기준으로 적을 느리게 만듬
            if (z.ownerId === 'player') {
                if (insideAI && !z.inside.ai) {
                    this.ai.applyStun(this.time, GAME_CONFIG.trailSlowDuration);
                }
            } else if (z.ownerId === 'ai') {
                if (insidePlayer && !z.inside.player) {
                    this.player.applyStun(this.time, GAME_CONFIG.trailSlowDuration);
                }
            }

            // 다음 스텝 진입/이탈 판정용 상태 갱신
            z.inside.player = insidePlayer;
            z.inside.ai = insideAI;
        }
    }

    // ============================================================
    // 내부 유틸: 이동/스킬/공격/아이템/충돌
    // ============================================================
    applyMovementAction(dragon, action, dt) {
        if (!dragon?.alive || !action) return;

        const moveX = clamp(action.moveX ?? 0, -1, 1);
        const moveY = clamp(action.moveY ?? 0, -1, 1);

        const speed = dragon.moveSpeed ?? 650;
        const target = new Vector2(
            dragon.pos.x + moveX * speed * dt,
            dragon.pos.y + moveY * speed * dt
        );
        
        // 이동 의도 방향을 바라보게
        if (Math.abs(moveX) > 1e-3 || Math.abs(moveY) > 1e-3) {
            dragon.facing = Math.atan2(moveY, moveX);
        }

        dragon.setMoveTarget(target);
    }

    applySkillAction(self, enemy, action) {
        if (!self?.alive || !action) return;

        // W: 공격 반사
        if (action.useW) self.skill.useW();

        // Q: 유도 화염 (멀티샷 개수 만큼)
        if (action.useQ && self.skill.useQ()) {
            const count = self.multiShotLevel;
            for (let i = 0; i < count; i++) {
                const dir = new Vector2(enemy.pos.x - self.pos.x, enemy.pos.y - self.pos.y).normalize();

                this.projectiles.push(new Projectile({
                    pos: self.pos,
                    dir,
                    speed: GAME_CONFIG.projectileSpeed * 0.9,
                    owner: self.id === 'player' ? ProjectileOwner.PLAYER : ProjectileOwner.AI,
                    color: self.color,
                    homing: true,
                    targetRef: enemy,
                    stunOnHit: false,
                    canReflect: true,
                    maxDistance: GAME_CONFIG.rangeHoming,
                    kind: 'HOMING',
                }));
            }
        }

        // E: 스턴탄
        if (action.useE && self.skill.useE()) {
            let dir;
            if (typeof action.dirX === 'number' && typeof action.dirY === 'number') {
                // 플레이어가 지정한 조준 방향(마우스)
                dir = new Vector2(action.dirX, action.dirY).normalize();
            } else {
                // 백업: 적 방향
                dir = new Vector2(enemy.pos.x - self.pos.x, enemy.pos.y - self.pos.y).normalize();
            }
            

            this.projectiles.push(new Projectile({
                pos: self.pos,
                dir,
                speed: GAME_CONFIG.projectileSpeed * 0.8,
                owner: self.id === 'player' ? ProjectileOwner.PLAYER : ProjectileOwner.AI,
                color: self.color,
                homing: false,
                targetRef: null,
                stunOnHit: true,
                canReflect: true,
                maxDistance: GAME_CONFIG.rangeStun,
                kind: 'STUN',
            }));
        }

        // R: 불꽃 잔상 + 이미지가 날아가는 스킬
        if (action.useR && self.skill.useR()) {
            let dir;
            if (typeof action.dirX === 'number' && typeof action.dirY === 'number') {
                // 플레이어가 지정한 조준 방향(마우스)
                dir = new Vector2(action.dirX, action.dirY).normalize();
            } else {
                // 백업: 적 방향
                dir = new Vector2(enemy.pos.x - self.pos.x, enemy.pos.y - self.pos.y).normalize();
            }

            // 고정 장판 생성
            // 시전 시점의 위치와 바라보는 방향으로 장판 생성   
            const length = GAME_CONFIG.rangeGeneral + GAME_CONFIG.rangeTrailExtra;
            const thickness = GAME_CONFIG.trailThickness * 1.5;

            const dirUnit = Vector2.from(dir);
            const n = new Vector2(-dirUnit.y, dirUnit.x);

            this.trailZones.push({
                id: this.trailZoneId++,
                ownerId: self.id, // 'player' | 'ai'

                // 고정된 장판 위치/방향(시전 순간 기준)
                origin: Vector2.from(self.pos),
                dir: dirUnit,
                n,
                length,
                thickness,
                halfThickness: thickness / 2,
                expireAt: this.time + GAME_CONFIG.skillDurations.R,
                inside: { player: false, ai: false },
                color: self.color,
            })
        
            this.projectiles.push(new Projectile({
                pos: self.pos,
                dir,
                speed: GAME_CONFIG.projectileSpeed * 0.8,
                owner: self.id === 'player' ? ProjectileOwner.PLAYER : ProjectileOwner.AI,
                color: self.color,
                homing: false,
                targetRef: null,
                stunOnHit: false,
                canReflect: false,
                maxDistance: GAME_CONFIG.rangeGeneral + GAME_CONFIG.rangeTrailExtra,
                sprite: null,
                kind: 'TRAIL',
            }));
        }

        // F: 점멸
        if (action.useF && self.skill.useF()) {
            const dist = GAME_CONFIG.blinkDistance;
            self.blink(dist);
        }
    }

    tryShoot(shooter, targetPos, who) {
        if (!shooter?.alive) return;

        const baseCd = GAME_CONFIG.basicAttackCooldown;
        if (who === 'player') {
            if (this.shootCdPlayer > 0) return;
            this.shootCdPlayer = baseCd;
        } else {
            if (this.shootCdAI > 0) return;
            this.shootCdAI = baseCd;
        }

        const dir = new Vector2(targetPos.x - shooter.pos.x, targetPos.y - shooter.pos.y);
        if (dir.length() < 1e-3) return;
        dir.normalize();

        shooter.facing = Math.atan2(dir.y, dir.x);

        const owner = shooter.id === 'player' ? ProjectileOwner.PLAYER : ProjectileOwner.AI;
        const color = shooter.color;

        const count = shooter.multiShotLevel;
        const spreadRad = (GAME_CONFIG.multiShotSpread * Math.PI) / 180;
        
        for (let i = 0; i < count; i++) {
            const t = count === 1 ? 0 : (i / (count - 1) - 0.5);
            const ang = spreadRad * t;
            const cos = Math.cos(ang);
            const sin = Math.sin(ang);
            const d = new Vector2(
                dir.x * cos - dir.y * sin,
                dir.x * sin + dir.y * cos,
            );

            this.projectiles.push(new Projectile({
                pos: shooter.pos,
                dir: d,
                speed: GAME_CONFIG.projectileSpeed,
                owner,
                color,
                homing: false,
                targetRef: null,
                stunOnHit: false,
                canReflect: true,
                maxDistance: GAME_CONFIG.rangeGeneral,
                kind: 'GEN',
            }));
        }
    }

    spawnItems(dt) {
        this.itemSpawnTimerPlayer -= dt;
        this.itemSpawnTimerAI -= dt;

        // 전역 랜덤 스폰 (플레이어/AI 영역 구분 없이)
        if (this.itemSpawnTimerPlayer <= 0) {
            this.itemSpawnTimerPlayer = GAME_CONFIG.itemSpawnInterval;
            const type = Math.random() < 0.5 ? ItemType.MULTI_SHOT : ItemType.HP_RECOVER;
            const x = GAME_CONFIG.width * Math.random();
            const y = GAME_CONFIG.height * Math.random();

            this.items.push(new Item({
                type,
                pos: { x, y },
                sprite: null,
                lifeTime: GAME_CONFIG.itemLifetime,
            }));
        }
    }

    handleCollisions() {
        // 투사체 vs 드래곤
        for (const p of this.projectiles) {
            if (!p.alive) continue;

            // 현재 탄이 향하고 있는 대상(피해자)와, 그 반대쪽(발사자) 계산
            const victim = p.owner === ProjectileOwner.PLAYER ? this.ai : this.player;
            const shooterBefore = p.owner === ProjectileOwner.PLAYER ? this.player : this.ai;

            if (!victim?.alive) continue;

            const dist = Vector2.distance(p.pos, victim.pos);
            // 충돌 체크
            if (dist < victim.radius + p.radius) {
                // W 반사 성공
                if (victim.skill.isInvulnerable() && p.canReflect) {
                    // 소유자 뒤집기
                    p.owner = p.owner === ProjectileOwner.PLAYER ? ProjectileOwner.AI : ProjectileOwner.PLAYER;
                    // 진행 방향 반전
                    p.dir.mul(-1);
                    // 유도탄(Q)인 경우, 이제 "새 적" = 원래 발사자 쪽으로 타겟 변경
                    // (stunOnHit인 E 스턴탄도 homing=false라, 그냥 직선으로만 날아감)
                    if (p.homing) {
                        p.targetRef = shooterBefore;
                    }
                    // W 반사 성공 처리(쿨감 등)
                    victim.skill.onReflectSuccess();
                    this.events.push({ type: 'reflect', by: victim.id });
                } else if (p.stunOnHit && victim.skill.pendingStunPurifyWindow > 0) {
                    // D 정화 창 안에 적 E 스턴탄 맞음 → 피해·스턴 없음
                    p.alive = false;
                    victim.skill.pendingStunPurifyWindow = 0;
                    this.events.push({ type: 'stun_purified', by: victim.id });
                } else {
                    // 실제 피격
                    p.alive = false;
                    victim.takeDamage(1);

                    // E 스턴탄인 경우: 맞은 쪽에 스턴
                    if (p.stunOnHit) {
                        victim.applyStun(this.time, GAME_CONFIG.skillDurations.ESlowDuration);
                    }
                }
            }
        }

        this._applyTrailZoneEffects();

        for (const item of this.items) {
            if (!item.alive) continue;

            // 플레이어와 거리
            const dP = Vector2.distance(item.pos, this.player.pos);
            if (this.player.alive && dP < (item.radius + this.player.radius)) {
                this._applyItemEffect(this.player, item);
                continue;
            }

            // AI와 거리
            const dA = Vector2.distance(item.pos, this.ai.pos);
            if (this.ai.alive && dA < (item.radius + this.ai.radius)) {
                this._applyItemEffect(this.ai, item);
                continue;
            }
        }
    }

    _applyItemEffect(target, item) {
        if (!target?.alive || !item) return;

        if (item.type === ItemType.MULTI_SHOT) {
            target.grantMultiShot(this.time);
        } else if (item.type === ItemType.HP_RECOVER) {
            target.heal(1);
        }

        item.alive = false;
        this.events.push({ type: 'item_pick', by: target.id, itemType: item.type });
    }
}