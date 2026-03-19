// ===== 스킬 쿨타임 및 지속 상태 (Q 유도, W 반사, E 스턴, R 잔상, D 정화, F 점멸) =====
import { GAME_CONFIG } from './config.js';

export class SkillManager {
    constructor(ownerId) {
        this.ownerId = ownerId;

        // 각 스킬 쿨타임 남은 시간(초)
        this.cooldowns = {
            Q: 0,
            W: 0,
            E: 0,
            R: 0,
            D: 0,
            F: 0,
        };

        // 스킬 효과 지속 시간(초)
        this.active = {
            W: 0, // 반사
            E: 0, // 스턴 효과 (실제 스턴은 Dragon 쪽에서 slowUntil로 적용)
            R: 0, // 잔상 
        };

        // W 발동 후 1초 내에 반사 성공 시 W 쿨 5초 감소
        this.pendingReflectWindow = 0;
    }

    update(dt) {
        // 쿨타임 감소
        for (const k of Object.keys(this.cooldowns)) {
            this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);
        }
        for (const k of Object.keys(this.active)) {
            this.active[k] = Math.max(0, this.active[k] - dt);
        }

        // 반사 가능 시간
        if (this.pendingReflectWindow > 0) {
            this.pendingReflectWindow = Math.max(0, this.pendingReflectWindow - dt);
        }
    }

    canUse(key) {
        return this.cooldowns[key] <= 0;
    }
    
    useQ() {
        if (!this.canUse('Q')) return false;
        this.cooldowns.Q = GAME_CONFIG.skillCooldowns.Q;
        return true;
    }
    
    useW() {
        if (!this.canUse('W')) return false;
        this.active.W = GAME_CONFIG.skillDurations.W;
        this.cooldowns.W = GAME_CONFIG.skillCooldowns.W;
        this.pendingReflectWindow = 1.0;
        return true;
    }

    useE() {
        if (!this.canUse('E')) return false;
        this.cooldowns.E = GAME_CONFIG.skillCooldowns.E;
        this.active.E = GAME_CONFIG.skillDurations.ESlowDuration;
        return true;
    }
    
    useR() {
        if (!this.canUse('R')) return false;
        this.active.R = GAME_CONFIG.skillDurations.R;
        this.cooldowns.R = GAME_CONFIG.skillCooldowns.R;
        return true;
    }

    /** 정화(D): R 스턴+데미지 해제. 100초 쿨. 스턴 중에만 유효. */
    useD() {
        if (!this.canUse('D')) return false;
        this.cooldowns.D = GAME_CONFIG.skillCooldowns.D;
        return true;
    }

    /** 점멸(F): 짧은 거리 순간이동, 300초 쿨 */
    useF() {
        if (!this.canUse('F')) return false;
        this.cooldowns.F = GAME_CONFIG.skillCooldowns.F;
        return true;
    }

    // 무적 상태인지 확인
    isInvulnerable() {
        return this.active.W > 0;
    }

    // 잔상 유지 중인지 확인
    hasTrail() {
        return this.active.R > 0;
    }

    // 스턴 효과 중인지 확인
    isStunned() {
        return this.active.E > 0;
    }

    // W 반사 성공 시 호출 → W 쿨 5초 감소
    onReflectSuccess() {
        if (this.pendingReflectWindow > 0) {
            this.cooldowns.W -= Math.max(0, this.cooldowns.W - 5);
            this.pendingReflectWindow = 0;
        }
    }

    getCooldownStatus() {
        return {
            Q: this.cooldowns.Q,
            W: this.cooldowns.W,
            E: this.cooldowns.E,
            R: this.cooldowns.R,
            D: this.cooldowns.D,
            F: this.cooldowns.F,
        }
    }
}