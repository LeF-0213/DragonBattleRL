# PPO 한쪽 vs 룰 기반 상대 (self-play 아님)
# - 기본: PPO = player, rule = ai (rule_opponent.rule_action_from_obs(obs_ai, side="ai"))
# - ppo_side="ai" 로 바꾸면 PPO = ai, rule = player
from __future__ import annotations

import os
import random
from dataclasses import dataclass
from typing import List

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim
from torch.distributions import Categorical

from coregame_env import CoreGameBridgeEnv
from obs_action import OBS_DIM, flatten_obs, action_to_coregame, ACTION_DIMS, MAX_PROJECTILES, MAX_ITEMS
from rule_opponent import rule_action_from_obs

@dataclass
class Cfg:
    total_steps: int = 500_000
    rollout_steps: int = 2048
    epochs: int = 8
    minibatch_size: int = 512
    gamma: float = 0.99
    gae_lambda: float = 0.95
    clip_eps: float = 0.2
    ent_coef: float = 0.01
    vf_coef: float = 0.5
    max_grad_norm: float = 0.5
    lr: float = 3e-4
    hidden: int = 256
    seed: int = 2026
    checkpoint_dir: str = "checkpoints"
    checkpoint_every_rollouts: int = 10
    # 룰 상대 난이도: easy | normal
    rule_level: str = "normal"
    # PPO가 조종할 쪽: "player" | "ai"
    ppo_side: str = "player"

cfg = Cfg()

def set_seed(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)

class ActorCritic(nn.Module):
    def __init__(self, obs_dim: int, action_dims: List[int], hidden: int = 256):
        super().__init__()
        self.action_dims = action_dims
        self.backbone = nn.Sequential(
            nn.Linear(obs_dim, hidden),
            nn.Tanh(),
            nn.Linear(hidden, hidden),
            nn.Tanh(),
        )
        self.value_head = nn.Linear(hidden, 1)
        self.policy_head = nn.ModuleList([nn.Linear(hidden, d) for d in action_dims])

    def forward(self, x):
        h = self.backbone(x)
        value = self.value_head(h).squeeze(-1)
        logits = [head(h) for head in self.policy_head]

        return logits, value

    def sample_action(self, x):
        logits, value = self.forward(x)
        dists = [Categorical(logits=l) for l in logits]
        acts = [d.sample() for d in dists]
        logp = torch.stack([d.log_prob(a) for d, a in zip(dists, acts)], dim=1).sum(dim=-1)
        ent = torch.stack([d.entropy() for d in dists], dim=-1).sum(dim=-1)
        action = torch.stack(acts, dim=-1)

        return action, logp, ent, value
        
    def evaluate_action(self, x, action):
        logits, value = self.forward(x)
        dists = [Categorical(logits=l) for l in logits]
        logp = torch.stack([d.log_prob(action[:, i]) for i, d in enumerate(dists)], dim=-1).sum(dim=-1)
        ent = torch.stack([d.entropy() for d in dists], dim=-1).sum(dim=-1)

        return logp, ent, value

def compute_gae(
    rews: torch.Tensor,
    vals: torch.Tensor,
    dones: torch.Tensor,
    last_val: float,
    gamma: float,
    lam: float,
):
    T = len(rews)
    adv = torch.zeros(T, dtype=torch.float32)
    lastgaelam = 0.0
    for t in reversed(range(T)):
        nextnonterminal = 1.0 - dones[t]
        nextvalue = last_val if t == T - 1 else vals[t + 1]
        delta = rews[t] + gamma * nextvalue * nextnonterminal - vals[t]
        lastgaelam = delta + gamma * lam * nextnonterminal * lastgaelam
        adv[t] = lastgaelam
    ret = adv + vals

    return adv, ret

def main() -> None:
    set_seed(cfg.seed)
    os.makedirs(cfg.checkpoint_dir, exist_ok=True)
    
    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")

    print(f"[init] OBS_DIM={OBS_DIM} (from flatten_obs dummy), ppo_side={cfg.ppo_side}, rule_level={cfg.rule_level}")
    
    env = CoreGameBridgeEnv()
    net = ActorCritic(OBS_DIM, ACTION_DIMS, cfg.hidden).to(device)
    opt = optim.Adam(net.parameters(), lr=cfg.lr)
    rule_rng = random.Random(cfg.seed + 7)
    obs_p, obs_ai = env.reset(player_color="black")

    def obs_tensor_for_ppo() -> torch.Tensor:
        if cfg.ppo_side == "player":
            return torch.tensor(flatten_obs(obs_p), dtype=torch.float32, device=device)
        if cfg.ppo_side == "ai":
            return torch.tensor(flatten_obs(obs_ai), dtype=torch.float32, device=device)
        raise ValueError(f"ppo_side must be 'player' or 'ai', got {cfg.ppo_side}")

    o_ppo = obs_tensor_for_ppo()
    global_step = 0
    rollout_idx = 0

    while global_step < cfg.total_steps:
        buf_obs: List[torch.Tensor] = []
        buf_act: List[torch.Tensor] = []
        buf_logp: List[torch.Tensor] = []
        buf_rew: List[torch.Tensor] = []
        buf_done: List[torch.Tensor] = []
        buf_val: List[torch.Tensor] = []
        ep_rewards: List[float] = []

        for _ in range(cfg.rollout_steps):
            with torch.no_grad():
                a_vec, logp, _, v = net.sample_action(o_ppo.unsqueeze(0))
            ppo_action = action_to_coregame(a_vec.squeeze(0).cpu().numpy())
            if cfg.ppo_side == "player":
                action_player = ppo_action
                action_ai = rule_action_from_obs(
                    obs_ai, level=cfg.rule_level, rng=rule_rng, side="ai"
                )
                reward_key = "rewardPlayer"
            else:
                action_ai = ppo_action
                action_player = rule_action_from_obs(
                    obs_p, level=cfg.rule_level, rng=rule_rng, side="player"
                )
                reward_key = "rewardAI"

            out = env.step(action_player, action_ai)
            next_obs_p = out["obsPlayer"]
            next_obs_ai = out["obsAI"]
            r = float(out[reward_key])
            done = bool(out["done"])

            buf_obs.append(o_ppo.detach().cpu())
            buf_act.append(a_vec.squeeze(0).detach().cpu())
            buf_logp.append(logp.squeeze(0).detach().cpu())
            buf_rew.append(torch.tensor(r, dtype=torch.float32))
            buf_done.append(torch.tensor(float(done), dtype=torch.float32))
            buf_val.append(v.squeeze(0).detach().cpu())
            ep_rewards.append(r)

            global_step += 1

            if done:
                obs_p, obs_ai = env.reset(player_color=random.choice(["black", "white"]))
            else:
                obs_p, obs_ai = next_obs_p, next_obs_ai

            o_ppo = obs_tensor_for_ppo()

        with torch.no_grad():
            _, last_v_t = net.forward(o_ppo.unsqueeze(0))
            last_v = last_v_t.item()

        rews = torch.stack(buf_rew)
        vals = torch.stack(buf_val)
        dones = torch.stack(buf_done)
        adv, ret = compute_gae(rews, vals, dones, last_v, cfg.gamma, cfg.gae_lambda)
        adv = (adv - adv.mean()) / (adv.std() + 1e-8)
        obs_t = torch.stack(buf_obs).to(device)
        act_t = torch.stack(buf_act).to(device).long()
        logp_old_t = torch.stack(buf_logp).to(device)
        adv_t = adv.to(device)
        ret_t = ret.to(device)
        n = obs_t.shape[0]
        inds = np.arange(n)

        for _ in range(cfg.epochs):
            np.random.shuffle(inds)
            for s in range(0, n, cfg.minibatch_size):
                mb = inds[s : s + cfg.minibatch_size]
                logp, ent, v = net.evaluate_action(obs_t[mb], act_t[mb])
                ratio = torch.exp(logp - logp_old_t[mb])
                surr1 = ratio * adv_t[mb]
                surr2 = torch.clamp(ratio, 1.0 - cfg.clip_eps, 1.0 + cfg.clip_eps) * adv_t[mb]
                pg_loss = -torch.min(surr1, surr2).mean()
                v_loss = ((v - ret_t[mb]) ** 2).mean()
                ent_loss = ent.mean()
                loss = pg_loss + cfg.vf_coef * v_loss - cfg.ent_coef * ent_loss
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), cfg.max_grad_norm)
                opt.step()

        rollout_idx += 1

        if rollout_idx % cfg.checkpoint_every_rollouts == 0:
            ckpt_path = os.path.join(cfg.checkpoint_dir, "ppo_vs_rule_latest.pt")
            torch.save(
                {
                    "model": net.state_dict(),
                    "step": global_step,
                    "cfg": cfg.__dict__,
                    "obs_dim": OBS_DIM,
                    "action_dims": ACTION_DIMS,
                    "ppo_side": cfg.ppo_side,
                    "rule_level": cfg.rule_level,
                },
                ckpt_path,
            )
            print(f"[ckpt] step={global_step:,} saved={ckpt_path}")
        print(f"[rollout {rollout_idx}] step={global_step:,} mean_step_r={np.mean(ep_rewards):.4f}")

    env.close()

if __name__ == "__main__":
    main()

