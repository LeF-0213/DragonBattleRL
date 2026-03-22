# CoreGame.getObservationFor(side) 결과(dict)만으로 룰 기반 액션 생성.
from __future__ import annotations
import random
from typing import Any, Dict

# src/game/config.js 와 동일
W, H = 1920, 1080
RANGE_GENERAL = 500
RANGE_HOMING = 500
RANGE_STUN = 500
RANGE_TRAIL_EXTRA = 150
STUN_PROJ_CLOSE_NORM = 0.22

def _enemy_owner_for_side(side: str) -> str:
    return "player" if side == "ai" else "ai"

# 적이 쏜 E 스턴탄(stun==1)이 나에게 상대적으로 가깝고,
# 속도 벡터가 나 쪽 성분을 가지면 위협으로 본다.
def _incoming_stun_threat(
    obs: Dict[str, Any],
    sx_n: float,
    sy_n: float,
    side: str,
) -> bool:
    enemy_o = _enemy_owner_for_side(side)
    projs = obs.get("projectiles", [])
    for p in projs:
        if p.get("owner") != enemy_o:
            continue
        if p.get("stun") != 0.5:
            continue
        px = float(p.get("x", 0.0))
        py = float(p.get("y", 0.0))
        vx = float(p.get("vx", 0.0))
        vy = float(p.get("vy", 0.0))
        dx = sx_n - px  
        dy = sy_n - py
        dist = (dx * dx + dy * dy) ** 0.5
        if dist > STUN_PROJ_CLOSE_NORM:
            continue
        # 투사체 진행 방향과 (탄 → 나) 방향이 같은 쪽이면 접근 중으로 간주
        toward = dx * vx + dy * vy
        if toward > 0.0:
            return True
    return False

def rule_action_from_obs(obs: Dict[str, Any], level: str = 'normal', rng: random.Random | None = None, side: str = 'ai') -> dict:
    # obs: 해당 side 입장 관측 (self / enemy 는 정규화 좌표)
    # level: 'easy' | 'normal' | 'hard'
    r = rng or random.Random()

    s = obs.get("self", {})
    e = obs.get("enemy", {})
    scd = s.get("cd", {})

    sx = float(s.get("x", 0.0)) * W
    sy = float(s.get("y", 0.0)) * H
    ex = float(e.get("x", 0.0)) * W
    ey = float(e.get("y", 0.0)) * H

    dx = ex - sx
    dy = ey - sy
    dist = (dx * dx + dy * dy) ** 0.5 or 1.0

    ux = dx / dist
    uy = dy / dist

    def can(key:str) -> bool:
        return float(scd.get(key, 99)) <= 1e-4

    action = {
        "moveX": 0.0,
        "moveY": 0.0,
        "shoot": False,
        "useQ": False,
        "useW": False,
        "useE": False,
        "useR": False,
        "useD": False,
        "useF": False,
        "dirX": dx,
        "dirY": dy,
    }

    if level == "easy":
        near, far, strafe = 310, 820, 0.35
        p_shoot_in, p_shoot_out = 0.55, 0.12
        p_q, p_e, p_r, p_w, p_f = 0.05, 0.045, 0.035, 0.015, 0.15
        p_d_parry = 0.35
    else:
        near, far, strafe = 260, 720, 0.75
        p_shoot_in, p_shoot_out = 0.85, 0.25
        p_q, p_e, p_r, p_w, p_f = 0.10, 0.09, 0.07, 0.04, 0.25
        p_d_parry = 0.65

    if dist < near:
        mvx, mvy = -ux, -uy
    elif dist > far:
        mvx, mvy = ux, uy
    else:
        px, py = -uy, ux
        mvx = ux * (1 - strafe) + px * strafe
        mvy = uy * (1 - strafe) + py * strafe

    action["moveX"] = max(-1.0, min(1.0, mvx))
    action["moveY"] = max(-1.0, min(1.0, mvy))

    action["shoot"] = r.random() < (p_shoot_in if dist < RANGE_GENERAL else p_shoot_out)

    if can("Q") and dist < RANGE_HOMING * 0.95 and dist > 180:
        action["useQ"] = r.random() < p_q
    if can("E") and dist < RANGE_STUN and dist > 160:
        action["useE"] = r.random() < p_e
    r_max = RANGE_GENERAL + RANGE_TRAIL_EXTRA
    if can("R") and dist < r_max and dist > 220:
        action["useR"] = r.random() < p_r
    if can("F") and dist < 240:
        action["useF"] = r.random() < p_f
    if can("W"):
        action["useW"] = r.random() < p_w

    stunned = float(s.get("stunned", 0) or 0) >= 0.5
    if can("D") and stunned:
        action["useD"] = True
    elif can("D") and _incoming_stun_threat(obs, sx, sy, side):
        action["useD"] = r.random() < p_d_parry

    return action