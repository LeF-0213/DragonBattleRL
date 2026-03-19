// ============================================================
// Item.js - 영역 내 드롭 아이템 (멀티샷 / HP 회복)
// ============================================================
// - CoreGame에서 스폰하며, 각 드래곤은 "자기 영역"에 떨어진
//   아이템만 접촉 시 획득 가능.
// - belongsTo: 'player' | 'ai' → 어느 쪽 영역에서 낙하하는지
// - 스프라이트가 있으면 이미지로, 없으면 원+문자로 렌더
// ============================================================

import { GAME_CONFIG } from "./config.js";
import { Vector2 } from "./Vector2.js";

export const ItemType = {
    // 멀티 샷: 기본 탄환 개수 증가 (최대 3개, 각도 확산)
    MULTI_SHOT: 'multi_shot',
    // HP 회복: 체력 1 회복 (최대 5)
    HP_RECOVER: 'hp_recover',
}

/**
 * 아이템 클래스
 * - 위치(pos), 종류(type), 소속 영역(belongsTo) 보관
 * - update(dt): 낙하만 처리. 영역 밖으로 나가면 alive = false
 * - draw(ctx): 스프라이트 이미지로 렌더
 */
export class Item {
    constructor({ type, pos, belongsTo = null, sprite = null, lifeTime = null }) {
        this.type = type;
        this.pos = Vector2.from(pos);
        this.radius = 36;
        this.sprite = sprite;
        this.alive = true;
        this.lifeTime = GAME_CONFIG.itemLifetime; // 초 단위, 1분 유지
    }

    /**
    * 매 프레임 호출.
    * - 화면 밖으로 완전히 나가면 alive = false.
    */
    update(dt) {
        this.lifeTime -= dt;
        if (this.lifeTime <= 0) {
            this.alive = false;
            return;
        }
        if (this.belongsTo === 'player') {
            this.pos.y += GAME_CONFIG.itemFallSpeed * dt;
            if (this.pos.y > GAME_CONFIG.height) this.alive = false;
        } else if (this.belongsTo === 'ai') {
            this.pos.y -= GAME_CONFIG.itemFallSpeed * dt;
            if (this.pos.y < 0) this.alive = false;
        }
    }

    draw(ctx) {
        ctx.save();
        ctx.translate(this.pos.x, this.pos.y);

        if (this.sprite && this.sprite.complete) {
            const img = this.sprite;

            const baseHeight = this.radius * 2;
            const aspect =
                img.naturalWidth && img.naturalHeight
                    ? img.naturalWidth / img.naturalHeight
                    : 1;

            const w = baseHeight * aspect;
            const h = baseHeight;

            const size = this.radius * 2;
            ctx.drawImage(this.sprite, -size / 2, -size / 2, size, size);
            ctx.restore();
            return;
        }
    }
}