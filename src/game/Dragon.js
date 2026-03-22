// ===== 드래곤 엔티티 (HP, 스킬, 멀티샷, 이동 제한) =====
import { Vector2 } from './Vector2.js';
import { GAME_CONFIG } from './config.js';
import { SkillManager } from './SkillManager.js';

export class Dragon {
    constructor({ id, pos, color, half, sprite = null }) {
        this.id = id;                   // 'player' 또는 'ai'
        this.pos = Vector2.from(pos);
        this.targetPos = Vector2.from(pos);
        this.color = color;
        this.sprite = sprite;           // 랜더 전용, CoreGame에서는 null
        this.half = half;               // 'bottom' (플레이어) | 'top' (AI)
        this.radius = 40;
        this.hpMax = GAME_CONFIG.playerHPMAX;
        this.hp = this.hpMax;
        this.alive = true;
        this.skill = new SkillManager(id);
        this.multiShotLevel = 1;         // 1~3
        this.baseMultiShotCount = 1;     // 기본 멀티샷 개수
        this.tempMultiShotUntil = 0;     // 임시 멀티샷 지속 시간
        this.slowUntil = 0;              // 스턴 종료 시각
        this.facing = 0;                 // 바라보는 각도 (라디안, 0 = 오른쪽)
        this.moveSpeed = 650;            // 초당 이동 거리 (논리 픽셀)
        this.trailSpeedMultipier = 1.0;
    }

    // 점멸(F): 현재 바라보는 방향으로 distance만큼 즉시 이동
    blink(distance) {
        // 바라보는 방향 기준 이동 벡터
        const dx = Math.cos(this.facing) * distance;
        const dy = Math.sin(this.facing) * distance;

        // 목표 위치
        const target = new Vector2(this.pos.x + dx, this.pos.y + dy);

        // setMoveTarget로 맵 경계에 맞게 클램프
        this.setMoveTarget(target);
        // 즉시 순간이동
        this.pos = this.targetPos.copy();
    }

    isStunned(now) {
        return now < this.slowUntil;
    }

    applyStun(now, duration) {
        this.slowUntil = Math.max(this.slowUntil, now + duration);
    }

    clearStun() {
        this.slowUntil = 0;
    }

    tryBreakFree(now) {
        if (!this.isStunned(now)) return false;
        if (!this.skill.useD()) return false;
        this.clearStun();
        this.heal(1);
        return true;
    }

    processDInput(now) {
        if (this.isStunned(now)) {
            return this.tryBreakFree(now);
        }
        if (!this.skill.canUse('D')) return false;
        if (!this.skill.useD()) return false;
        this.skill.beginStunPurifyWindow();
        return true;
    }

    takeDamage(amount) {
        if (this.skill.isInvulnerable()) return;
        this.hp = Math.max(0, this.hp - amount);
        if (this.hp <= 0) this.alive = false;
    }

    heal(amount) {
        this.hp = Math.min(this.hpMax, this.hp + amount);
    }

    grantMultiShot(now) {
        const max = GAME_CONFIG.multiShotMax;

        // 즉시 + 1 (최대치까지만)
        if (this.multiShotLevel < max) this.multiShotLevel++;

        // 버프 만료 시각
        const BUFF_DURATION = 5;
        this.multiShotBuffUntil = Math.max(this.multiShotBuffUntil, now + BUFF_DURATION);
    }

    // 이동 목표 설정 + 상/하 영역 제한 
    setMoveTarget(pos) {
        this.targetPos = Vector2.from(pos);

        //전체 화면 범위 제한
        const margin = 40;

        if (this.targetPos.x < margin) this.targetPos.x = margin;
        if (this.targetPos.x > GAME_CONFIG.width - margin) this.targetPos.x = GAME_CONFIG.width - margin;
        if (this.targetPos.y < margin) this.targetPos.y = margin;
        if (this.targetPos.y > GAME_CONFIG.height - margin) this.targetPos.y = GAME_CONFIG.height - margin;
    }

    update(dt, now) {
        this.skill.update(dt);

        // 5초 버프 만료 처리: 시간이 지나면 다시 기본으로
        if (this.tempMultiShotUntil > 0 && now > this.tempMultiShotUntil) {
            this.tempMultiShotUntil = 0;
            this.multiShotLevel = this.baseMultiShotCount;
        }

        const dir = Vector2.from(this.targetPos).sub(this.pos)
        const dist = dir.length();

        if (dist > 1) {
            dir.normalize();
            let speed = this.moveSpeed * (this.trailSpeedMultipier || 1.0);
            if (this.isStunned(now)) speed *= 0.5;

            const move = Math.min(dist, speed * dt);
            this.pos.x += dir.x * move;
            this.pos.y += dir.y * move;
        }

        // 멀티샷 버프 만료 처리
        if (this.multiShotBuffUntil > 0 && now > this.multiShotBuffUntil) {
            if (this.multiShotLevel > 1) {
                this.multiShotLevel--;
            }
            this.multiShotBuffUntil = 0;
        }
    }

    // 이미지 렌더링
    draw(ctx) {
        if (!this.alive) return;

        ctx.save();
        ctx.translate(this.pos.x, this.pos.y);

        // 회전: facing 각도만큼 회전 후 이미지 그리기
        ctx.rotate(this.facing + Math.PI / 2);

        // 드래곤 이미지
        if (this.sprite && this.sprite.complete) {
            const baseHeight = 140;
            const img = this.sprite;
            const aspect = img.naturalWidth / img.naturalHeight
                ? img.naturalWidth / img.naturalHeight
                : 1.5;

            const w = baseHeight * aspect;
            const h = baseHeight;

            // 이미지 중심을 드래곤 위치로 맞춤
            ctx.drawImage(img, -w / 2, -h / 2, w, h);
        }

        ctx.restore();

        // ==========================================================
        // W 반사(무적) 이펙트: reflectSprite를 드래곤 위치에 오버레이
        // - 검은 드래곤: reflect_b.webP
        // - 하얀 드래곤: reflect_w.webP
        // ==========================================================
        if (this.skill.isInvulnerable() && this.reflectSprite && this.reflectSprite.complete) {
            ctx.save();
            ctx.translate(this.pos.x, this.pos.y);
            // 드래곤 스프라이트와 같은 회전
            ctx.rotate(this.facing + Math.PI / 2);

            const t = performance.now() * 0.008;
            const pulse = 1.0 + 0.06 * Math.sin(t);

            // 타원 반축
            // radiusX > radiusY 이면 가로로 납작한(넓은) 타원
            const radiusX = 180 * pulse;
            const radiusY = 83 * pulse;

            ctx.globalAlpha = 0.85;

            // 타원 경로를 만들고
            ctx.beginPath();
            // ellipse(cx, cy, rx, ry, rotation, startAngle, endAngle)
            // rotation=0 이면 화면 기준 가로/세로 정렬 타원
            ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, 2 * Math.PI);

            // 이후 그리기는 타원 안에서만 보이게 잘라냄 (마스크)
            ctx.clip();

            // 이미지를 타원의 바운딩 박스(2*rx × 2*ry)에 맞춰 그림
            //    → 모서리 바깥은 clip에 의해 잘려서 타원형으로 보임
            const w = radiusX * 2;
            const h = radiusY * 2;
            ctx.drawImage(this.reflectSprite, -w / 2, -h / 2, w, h);

            ctx.restore();
        }

        // R 스킬(불꽃 잔상)
        if (this.skill.hasTrail()) {
            // 남은 지속 비율 (0~1) → 애니메이션용
            const remain = this.skill.active.R;
            const duration = GAME_CONFIG.skillDurations.R || 1.0;
            const t = Math.max(0, Math.min(1, remain / duration));

            // 길이 = 기본 사거리 + 추가분 (한쪽 방향 전체 길이)
            const length = (GAME_CONFIG.rangeGeneral) + (GAME_CONFIG.rangeTrailExtra);
            // 두께(폭)
            const thickness = GAME_CONFIG.trailThickness * 1.5;

            // 색상: 붉은/푸른 불꽃 느낌으로 구분
            const isRed = this.id === 'player'
                ? (this.color.includes('ff7'))
                : !(this.color.includes('ff7'))

            const baseColor = isRed
                ? { r: 255, g: 120, b: 80 }   // 붉은 불꽃 계열
                : { r: 90,  g: 180, b: 255 }; // 푸른 불꽃 계열

            // 남은 시간에 따라 alpha, glow 강도 변화
            const alpha = 0.15 + 0.35 * t;
            const glow = 10 + 30 * t;
            const dirAngle = (this.facing || 0) + Math.PI / 2;

            ctx.save();
            ctx.translate(this.pos.x, this.pos.y);
            ctx.rotate(dirAngle + Math.PI / 2);

            ctx.globalAlpha = alpha;
            ctx.shadowBlur = glow;
            ctx.shadowColor = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 1)`;
    
            // 위아래로 살짝 진한 그라디언트
            const x = 0;
            const y = -thickness / 2;
            const grad = ctx.createLinearGradient(0, y, 0, y);
            // addColorStop: 0.0 ~ 1.0 사이 값을 주면 그라디언트 색상 변경
            grad.addColorStop(0.0, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.0)`);
            grad.addColorStop(0.2, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.6)`);
            grad.addColorStop(0.8, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.6)`);
            grad.addColorStop(1.0, `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.0)`);

            ctx.fillStyle = grad;
            ctx.fillRect(x, y, length, thickness);

            ctx.restore();
        }
    }
}