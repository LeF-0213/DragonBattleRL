export const GAME_CONFIG = {
    width: 1920,
    height: 1080,
    // 플레이어 체력 최대치
    playerHPMAX: 10,

    // 기본 공격 연사 상한
    basicAttackCooldown: 0.4,

    // 투사체 속도
    projectileSpeed: 900,
    baseProjectileCount: 1, // 기본 투사체 개수
    projectileRadius: 8, // 투사체 반경

    // 아이템 스폰 간격(초), 낙하 속도
    itemSpawnInterval: 8,
    itemFallSpeed: 300,

    // 유도탄 회전률 (리디안/초)
    homingTurnRate: 4,

    // 스킬 쿨타임(초): Q 10, W 20, E 30, R 70, D 100
    skillCooldowns: {
        Q: 10,
        W: 20,
        E: 30,
        R: 70,
        D: 180,
        F: 300,
    },

    // 스킬 지속 시간
    skillDurations: {
        W: 1.0,             // W 무적
        ESlowDuration: 1.0, // E 스턴 유지
        R: 4.0,             // R 잔상
    },

    // D(정화): 누른 뒤 이 시간(초) 안에 적 E 스턴탄에 맞으면 피해·스턴 무효
    stunPurifyWindow: 0.5,

    // R 장판 관련 밸런스
    // 적이 장판을 진입할 때만 1초 둔화가 걸리도록(중복 진입 방지)
    trailSlowDuration: 1.0,
    // 시전자가 장판 위에 있으면 이동 속도가 증가하도록
    trailSpeedMultiplier: 1.25,

    // 멀티샷 최대 개수, 확산 각도(도)
    multiShotMax: 3,
    multiShotSpread: 15,

    // 공격 사거리(예시값): 필요하면 숫자만 바꿔서 튜닝
    rangeGeneral: 500,    // 기본탄 사거리
    rangeHoming: 500,     // Q 유도탄 사거리
    rangeStun: 500,       // E 스턴탄 사거리
    rangeTrailExtra: 150, // R 잔상 추가 사거리
    trailThickness: 80, // 잔상의 두꼐(폭)

    // 점멸 이동 거리 (논리 좌표 기준)
    blinkDistance: 250,

    // 아이템 관련
    itemLifetime: 60,     // 아이템 1분 유지 (초)
};