// --------------------------------------------------
// 투사체(탄환 / 불꽃) 정의
// - 기본탄 / 유도탄(Q) / 스턴탄(R)
// - draw(ctx): 발광하는 불꽃 느낌으로 렌더링
// --------------------------------------------------
import { Vector2 } from './Vector2.js';
import { GAME_CONFIG } from './config.js';

export const ProjectileOwner = {
    PLAYER: "player",
    AI: "ai",
};

export class Projectile {
    constructor({
        pos,
        dir,
        speed,
        owner,
        color,
        homing = false,
        targetRef = null,
        stunOnHit = false,
        canReflect = true,
        maxDistance = Infinity,
        sprite = null,
        kind = null,
    }) {
        this.pos = Vector2.from(pos);
        this.startPos = Vector2.from(pos);
        this.dir = Vector2.from(dir).normalize();
        this.speed = speed;
        this.owner = owner;
        this.color = color;
        this.radius = GAME_CONFIG.projectileRadius;
        this.homing = homing;            // Q 유도 화염
        this.targetRef = targetRef;       
        this.stunOnHit = stunOnHit;       // R 스턴 화염
        this.canReflect = canReflect;     // W 반사 가능 여부
        this.maxDistance = maxDistance;
        this.sprite = sprite;
        this.kind = kind;
        this.alive = true;
    }

    update(dt) {
        // 유도탄: 목표(적) 방향으로 방향 보간
        if (this.homing && this.targetRef && this.targetRef.alive) {
            // 현재 위치에서 목표까지의 벡터
            const toTarget = Vector2.from(this.targetRef.pos).sub(this.pos);
            if (toTarget.length() > 1e-3) { // 목표가 너무 가까우면 무시
                toTarget.normalize();

                // 현재 dir에서 target dir로 점진적 보간
                this.dir.x += (toTarget.x - this.dir.x) * Math.min(1, GAME_CONFIG.homingTurnRate * dt);
                this.dir.y += (toTarget.y - this.dir.y) * Math.min(1, GAME_CONFIG.homingTurnRate * dt);
                this.dir.normalize();
            }
        }

        // 위치 갱신
        this.pos.x += this.dir.x * this.speed * dt;
        this.pos.y += this.dir.y * this.speed * dt;

        // 사거리 초과 체크
        const traveled = Vector2.distance(this.pos, this.startPos);
        if (traveled > this.maxDistance) {
            this.alive = false;
        }

        // 화면 밖이면 제거
        if (
            this.pos.x < -50 ||
            this.pos.x > GAME_CONFIG.width + 50 ||
            this.pos.y < -50 ||
            this.pos.y > GAME_CONFIG.height + 50
        ) {
            this.alive = false;
        }
    }

    // 캔버스에 투사체를 그리는 함수
    draw(ctx) {
        ctx.save();

        const isBlack = this.color === '#5bc5ff';
        const baseColor = isBlack ? { r: 90, g: 180, b: 255 } : { r: 255, g: 120, b: 80 };

        const img = this.sprite && (this.sprite.image || this.sprite);

        if (img && img.complete) {
            const angle = Math.atan2(this.dir.y, this.dir.x);
            ctx.translate(this.pos.x, this.pos.y);
            ctx.rotate(angle + Math.PI / 2);

            // 탄 이미지
            const baseSize = this.radius * 3;

            if (this.kind === 'TRAIL') {
                // R 스킬 등 이미지: 사거리 기반으로 길게
                const length = GAME_CONFIG.rangeGeneral + GAME_CONFIG.rangeTrailExtra;
                const baseHeight = 140;
                const aspect = 
                    img.naturalWidth / img.naturalHeight
                    ? img.naturalWidth / img.naturalHeight
                    : 1.5;

                const h = baseHeight;
                const w = Math.min(length, h * aspect * 2);

                ctx.globalAlpha = 0.7;
                ctx.drawImage(img, -w / 2, -h / 2, w, h);

                ctx.restore();
                ctx.save();

                ctx.translate(this.pos.x, this.pos.y + 20);
                ctx.scale(1.4, 0.5);
                ctx.globalAlpha = 0.35;

                // 색 있는 타원 잔상
                ctx.fillStyle = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.9 )`;
                ctx.beginPath();
                ctx.arc(0, 0, baseSize / 3, 0, Math.PI * 2);
                ctx.fill();

                ctx.restore();
                return;
            } else if (this.kind === 'HOMING') {
                // 유도탄: 부드러운 꼬리
                const size = baseSize * 1.5;
                ctx.globalAlpha = 0.95;
                ctx.drawImage(img, -size / 2, -size / 2, size, size);

                ctx.restore();

                ctx.save();
                const trailLen = 6; // 꼬리 길이 샘플 수
            
                for (let i = 0; i < trailLen; i++) {
                    const t = i / trailLen;
                    const px = this.pos.x + this.dir.x * this.radius * 2 * i;
                    const py = this.pos.y + this.dir.y * this.radius * 2 * i;

                    const alpha = 0.3 * (1 - t);
                    ctx.fillStyle = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, ${alpha})`;
                    ctx.beginPath();
                    ctx.arc(px, py, this.radius * 0.9, 0, Math.PI * 2);
                    ctx.fill();
                }
                ctx.restore();
                return;
            } else if (this.kind === 'STUN') {
                const size = baseSize * 1.6;
                ctx.globalAlpha = 0.95;
                ctx.drawImage(img, -size / 2, -size / 2, size, size);
                ctx.restore();

                ctx.save();
                ctx.translate(this.pos.x, this.pos.y);
                ctx.rotate(angle);

                ctx.strokeStyle = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 0.8)`;
                ctx.lineWidth = 2;
                ctx.shadowBlur = 14;
                ctx.shadowColor = `rgba(${baseColor.r}, ${baseColor.g}, ${baseColor.b}, 1)`;
                
                const len = this.speed * 0.12;
                const segments = 5;

                ctx.beginPath();
                ctx.moveTo(0, 0);

                for (let i = 1; i <= segments; i++) {
                   const x = -(len / segments) * i;
                   const y = (Math.random() - 0.5) * this.radius * 1.5;
                    ctx.lineTo(x, y);
                }
                ctx.stroke();
                ctx.restore();
                return;
            } else {
                const size = baseSize;
                ctx.globalAlpha = 0.95;
                ctx.drawImage(img, -size / 2, -size / 2, size, size);
                ctx.restore();
                return;
            }
        }
    }
}