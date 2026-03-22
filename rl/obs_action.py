# --------------------------------------------------------------
# CoreGame observation(dict)을 PPO 입력 벡터로 평탄화하고,
# PPO의 multi-discrete action을 CoreGame 액션 dict로 변환한다.
# 통역사 역할
# --------------------------------------------------------------
from __future__ import annotations # 타입 힌트(자기 자신의 클래스 타입을 참조할 때 사용, Python 3.7 이상 권장)
import numpy as np

# 상수 설정
# 화면에 투사체나 아이템이 몇 개가 있든, AI는 항상 고정됱 크기의 데이터를 받아야 합니다.
# 프로젝트에 맞춘 고정 길이 버킷 수
MAX_PROJECTILES = 40 # 투사체 최대 개수
MAX_ITEMS = 12 # 아이템 최대 개수

# 스킬별 최대 쿨타임 (데이터 정규화용: 0~1 사이의 값으로 변환하기 위해 사용)
CD_MAX = {"Q": 10.0, "W": 20.0, "E": 30.0, "R": 70.0, "D": 180.0, "F": 300.0}

# 모델이 출력할 행동의 가짓수 (Multi-Discrete 행동 공간 크기)
# [moveX, moveY, shoot, Q, W, E, R, D, F]
# moveX/Y는 3가지(왼쪽/정지/오른쪽), 나머지는 2가지(안함/함)
ACTION_DIMS = [3, 3, 2, 2, 2, 2, 2, 2, 2]

# --------------------------------------------------------------
# 유틸리티 함수
# --------------------------------------------------------------
# None 값이 들어온 경우 에러를 방지하고자 기본값(0.0)을 반환하는 함수
def _safe(x, default=0.0) -> float:
    return float(x) if x is not None else float(default)

# 쿨타임 값을 0.0(준비됨) ~ 1.0(최대 쿨타임) 사이로 정ㄱ화
def _norm_cd(v: float, key: str) -> float:
    m = CD_MAX[key]
    # np.clip: 값을 특정 범위 내에 제한하는 함수
    # _safe(v) / m: 현재/쿨타임
    return np.clip(_safe(v) / m, 0.0, 1.0)

# --------------------------------------------------------------
# CoreGame observation(dict)을 PPO 입력 벡터로 평탄화
# --------------------------------------------------------------
# 게임의 JSON 데이터를 1차원 numpy 배열(AI 입력값)로 변환
def flatten_obs(obs: dict) -> np.ndarray:
    # self / enemy 기본 정보 추출
    s = obs.get("self", {})
    e = obs.get("enemy", {})
    scd = s.get("cd", {})
    ecd = e.get("cd", {})

    # 핵심 상태 정보 (시간, 자신/적의 좌표, 체력, 스킬 상태 등)
    vec = [
        # time은 episode 길이를 모를 수 있으니 완전 clip 기반으로만 사용
        # 시간 경과: tanh를 이용해 0~1 사이로 수렴 (학습 안전성)
        # 초를 사용해 시간이 너무 커지면 그라디언트 폭주(Gradient Explosion)가 일어날 수도 있음
        np.tanh(_safe(obs.get("time")) / 120.0),

        # self 정보
        _safe(s.get("x")), _safe(s.get("y")), _safe(s.get("hp")),
        np.clip(_safe(s.get("multiShot")) / 3.0, 0.0, 1.0),
        _norm_cd(scd.get("Q"), "Q"), _norm_cd(scd.get("W"), "W"), _norm_cd(scd.get("E"), "E"),
        _norm_cd(scd.get("R"), "R"), _norm_cd(scd.get("D"), "D"), _norm_cd(scd.get("F"), "F"),

        # enemy
        _safe(e.get("x")), _safe(e.get("y")), _safe(e.get("hp")),
        np.clip(_safe(e.get("multiShot")) / 3.0, 0.0, 1.0),
        _norm_cd(ecd.get("Q"), "Q"), _norm_cd(ecd.get("W"), "W"), _norm_cd(ecd.get("E"), "E"),
        _norm_cd(ecd.get("R"), "R"), _norm_cd(ecd.get("D"), "D"), _norm_cd(ecd.get("F"), "F"),
    ]

    # --------------------------------------------------------------
    # projectiles 정보 - 패딩 처리 핵심
    # feature: x,y,vx,vy,owner_is_ai,homing,stun
    # --------------------------------------------------------------
    projs = obs.get("projectiles", [])[:MAX_PROJECTILES]
    for p in projs:
        vec.extend([
            _safe(p.get("x")), _safe(p.get("y")), _safe(p.get("vx")), _safe(p.get("vy")),
            1.0 if p.get("owner") == "ai" else 0.0,
            _safe(p.get("homing")), _safe(p.get("stun")),
        ])
    # 투사체 MAX_PROJECTILES 개수 보다 적으면 남은 자리를 0으로 채움 (Padding)
    for _ in range(MAX_PROJECTILES - len(projs)):
        vec.extend([0.0] * 7)

    # --------------------------------------------------------------
    # items (패딩)
    # feature: x,y,type_onehot(2) -> hp / multishot
    # --------------------------------------------------------------
    items = obs.get("items", [])[:MAX_ITEMS]
    for it in items:
        t = str(it.get("type", "")).lower()
        is_hp = 1.0 if "hp" in t else 0.0
        is_ms = 1.0 if ("multi" in t or "shot" in t) else 0.0
        vec.extend([_safe(it.get("x")), _safe(it.get("y")), is_hp, is_ms])
    for _ in range(MAX_ITEMS - len(items)):
        vec.extend([0.0] * 4)

    return np.asarray(vec, dtype=np.float32)

# 최종 입력 벡터의 길이를 계산 (AI 모델 설계시 필요)
OBS_DIM = int(1 + 10 + 10 + MAX_PROJECTILES * 7 + MAX_ITEMS * 4)

# --------------------------------------------------------------
# Action 변환 (De-Normalization: PPO 출력값을 CoreGame 액션 dict로 변환)
# De-Normalization은 정규화된 값을 원래 범위로 되돌리는 과정
# --------------------------------------------------------------
# AI가 선택한 정수 배열(a)을 게임이 이해하는 액션 딕셔너리로 변환
# a예시: [2, 1, 0, 0, ...]
def action_to_coregame(a: np.ndarray) -> dict:
    # 이동 관련: AI의 0, 1, 2 출력을 게임의 -1, 0, 1 로 매핑
    move_x = int(a[0]) - 1
    move_y = int(a[1]) - 1

    return {
        "moveX": int(np.clip(move_x, -1, 1)),
        "moveY": int(np.clip(move_y, -1, 1)),
        "shoot": bool(int(a[2])),
        "useQ": bool(int(a[3])),
        "useW": bool(int(a[4])),
        "useE": bool(int(a[5])),
        "useR": bool(int(a[6])),
        "useD": bool(int(a[7])),
        "useF": bool(int(a[8])),
    }

    