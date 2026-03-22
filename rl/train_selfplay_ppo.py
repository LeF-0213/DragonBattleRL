# --------------------------------------------------------------
# Self-play PPO 학습 스크립트
# - 단일 정책 네트워크 하나가 player/ai 양쪽을 동시에 조종
# - 같은 rollout 버퍼에 양측 transition을 모두 적재
# - PPO clip + GAE(lambda)로 업데이트
#
# 산출:
#   checkpoints/ppo_selfplay_latest.pt
# --------------------------------------------------------------
from __future__ import annotations
from dataclasses import dataclass # 클래스 정의시 자동으로 프로퍼티 생성
from typing import List

import os
import random
import numpy as np
import torch
import torch.nn as nn # 신경망 모델 정의
import torch.optim as optim # 옵티마이저(Optimizer): 모델 파라미터 최적화
from torch.distributions import Categorical # 이산 분포 생성 (e.g. 행동 선택)

from coregame_env import CoreGameBridgeEnv
from obs_action import flatten_obs, action_to_coregame, OBS_DIM, ACTION_DIMS

# --------------------------------------------------------------
# 하이퍼파라미터 설정
# --------------------------------------------------------------
@dataclass
class Cfg:
    total_steps: int = 1_000_000 # 총 학습 스텝 수
    rollout_steps: int = 2048 # 한 번의 에피소드에서 수집할 행동 수
    epochs: int = 8 # 모은 데이터를 몇 번 반복해서 학습할지
    minibatch_size: int = 512 
    gamma: float = 0.99 # 미래 보상을 얼마나 중시할지 (할인율)
    gae_lambda: float = 0.95 # GAE(이득 추정) 가중치 파라미터
    clip_eps: float = 0.2 # PPO clip 파라미터
    ent_coef: float = 0.01 # 엔트로피 계수 (AI가 다양한 시도를 하도록 유도)
    vf_coef: float = 0.5 # 가치 함수(Critic) 손실의 비중
    max_grad_norm: float = 0.5 # 기울기 폭주를 막기 위한 절단 값
    lr: float = 3e-4
    hidden: int = 256 # 신경망 내부 노드 수
    seed: int = 2026 
    checkpoint_dir: str = "checkpoints" # 모델 저장 폴더
    checkpoint_every_rollouts: int = 10 # 몇 번의 학습 묶음(Rollout)마다 모델 파일(.pt) 저장

cfg = Cfg()

def set_seed(seed: int):
    random.seed(seed)
    np,random.seed(seed)
    torch.manual_seed(seed)
    
# --------------------------------------------------------------
# 신경망 모델 (Actor-Critic 아키텍처)
# Actor: 상황을 판단하고 행동을 결정 (정책 네트워크)
# Critic: 상황의 가치를 추정 (가치 함수 네트워크)
# --------------------------------------------------------------
class ActorCritic(nn.Module):
    def __init__(self, obs_dim: int, action_dims: List[int], hidden: int = 256):
        super().__init__()
        self.action_dims = action_dims
        
        # Backbone: 모든 판단의 기초가 되는 공통 신경망 (특징 추출)
        self.backbone = nn.Sequential(
            nn.Linear(obs_dim, hidden), nn.Tanh(), 
            nn.Linear(hidden, hidden), nn.Tanh(),
        )
        # Value Head: 현재 상황의 가치(점수)를 예측 (Critic)
        self.value_head = nn.Linear(hidden, 1) # 좋은지 나쁜지 정도만 예측
        # Policy Head: 각 액션(이동, 공격 등)의 확률을 예측 (Actor)
        # ModuleList: 여러 모듈을 리스트로 관리하고 순회 가능하게 함
        # 각 액션에 대한 확률을 예측하는 별도의 신경망 모듈을 생성
        self.policy_head = nn.ModuleList([nn.Linear(hidden, d) for d in action_dims])

    # 입력(x)을 받아 신경망을 통과시켜 출력(logits, value)을 반환
    def forward(self, x):
        h = self.backbone(x) # 추상적 특징 벡터
        value = self.value_head(h).squeeze(-1) # 현재 상황의 가치(점수)를 예측, 상황 판단 점수
        logits = [head(h) for head in self.policy_head] # 각 행동 영역에 대한 확률 분포 생성, 결정된 행동 후보들
        return logits, value

    # 현재 상황(x)에서 확률적으로 행동 선택
    def sample_action(self, x):
        logits, value = self.forward(x)
        # 각 행동 영역에 대한 확률 분포 생성
        # Categorical: 이산 분포 생성 (e.g. 행동 선택, 점수가 높을 수록 뽑힐 확률이 높은 주사위)
        dists = [Categorical(logits=l) for l in logits]
        # 만들어진 주사위를 실제로 던져서 행동 번호를 뽑는다.
        # sample(): 분포에서 랜덤 샘플링 (e.g. 주사위 던지기)
        acts = [d.sample() for d in dists] 
        # log_prob(): 확률 분포에서 행동(a)이 나올 확률의 로그 값을 반환
        # 내가 방금 뽑은 행동들이 나온 확률이 얼마였는지 계산
        # PPO 업데이트 시 "이 행동이 얼마나 희귀하거나 당연했는지" 판단하는 기준이 됨
        logp = torch.stack([d.log_prob(a) for d, a in zip(dists, acts)], dim=1).sum(dim=-1)
        # entropy(): 분포의 엔트로피(불확실성)를 반환
        # 주사위가 얼마나 골고루 섞여 있나(불확실성)을 나타냄
        # 값이 높을수록 AI가 자신감 없이 이것저것 시도하고 있다는 뜻이다. (학습 초기에 중요)
        ent = torch.stack([d.entropy() for d in dists], dim=-1).sum(dim=-1)
        # stack(): 여러 텐서를 쌓아서 새로운 차원을 생성
        # 개별적으로 뽑은 행동들(예: [1, 0, 1...])을 하나의 리스트(Tensor)로 합친다.
        action = torch.stack(acts, dim=-1)

        return action, logp, ent, value
        
    # 오답노트
    def evaluate_action(self, x, action):
        logits, value = self.forward(x)
        dists = [Categorical(logits=l) for l in logits]
        # action[:, i]: i번째 행동(action)에 대한 데이터 묶음을 가져옴
        logp = torch.stack([d.log_prob(action[:, i]) for i, d in enumerate(dists)], dim=-1).sum(dim=-1)
        # 학습이 잘 될수록 특정 행동에 확신을 갖게 되어 엔트로피는 낮아진다.
        ent = torch.stack([d.entropy() for d in dists], dim=-1).sum(dim=-1)
        return logp, ent, value

# --------------------------------------------------------------
# 핵심 알고리즘 (GAE)
# AI가 한 행동이 얼마나 좋았는지 (Advantage)를 계산하는 알고리즘
# delta = 현재보상 + 할인율 * (미래가치 * reward_mask) - 현재가치
# --------------------------------------------------------------
def compute_gae(rews, vals, dones, last_val, gamma, lam):
    T = len(rews)              # 데이터의 총 길이 (타임스탭 수)
    adv = torch.zeros(T, dtype=torch.float32) 
    lastgaelam = 0.0            # 이전 타임스탭의 GAE 값

    # 미래에서 과거로 역순으로 계산
    for t in reversed(range(T)):
        # 게임이 끝났는지 확인 (끝났으면 다음 상태의 가치는 0)
        nextnonterminal = 1.0 - dones[t]

        # 마지막 루프라면 외부에서 가져온 last_val을 사용, 아니면 다음 상태의 가치를 사용
        nextvalue = last_val if t == T - 1 else vals[t + 1]
        # TD Error 계산
        delta = rews[t] + gamma * nextvalue * nextnonterminal - vals[t]

        # GAE 누적 계산 (단기 지표 + 미래의 지표들을 섞음)
        # GAE(Generalized Advantage Estimation): 미래의 보상을 고려하여 현재 보상을 조정하는 방법
        # lambda: 미래의 지표들을 얼마나 고려할지 결정하는 파라미터
        lastgaelam = delta + gamma * lam * nextnonterminal * lastgaelam

        # 최종 계산된 값을 어드밴티지 배열에 저장
        adv[t] = lastgaelam

    # 어드밴티지에 현재 가치를 더하면 AI가 목표로 해야 할 실제 목표값(Target)이 된다.
    ret = adv + vals
    return adv, ret
        
def main():
    set_seed(cfg.seed)
    os.makedirs(cfg.checkpoint_dir, exist_ok=True)

    if torch.backends.mps.is_available():
        device = torch.device("mps")
    elif torch.cuda.is_available():
        device = torch.device("cuda")
    else:
        device = torch.device("cpu")

    # 게임 엔진(Node.js)와 연결된 환경 생성
    env = CoreGameBridgeEnv()

    # AI 모델 생성 및 CPU/GPU 로 전송
    net = ActorCritic(OBS_DIM, ACTION_DIMS, cfg.hidden).to(device)
    # 최적화 도구(Adam): 신경망의 나사를 얼마나 세게 조일지 결정
    opt = optim.Adam(net.parameters(), lr=cfg.lr)

    # 게임판 초기화 및 첫 화면(관측값) 받아오기
    obs_p, obs_ai = env.reset(player_color="black")
    # 받아온 데이터를 AI가 읽을 수 있는 텐서(Tensor) 형태로 변환
    o_p = torch.tensor(flatten_obs(obs_p), dtype=torch.float32).to(device)
    o_ai = torch.tensor(flatten_obs(obs_ai), dtype=torch.float32).to(device)

    global_step = 0
    rollout_idx = 0

    # --------------------------------------------------------------
    # 데이터 수집
    # --------------------------------------------------------------
    while global_step < cfg.total_steps:
        # -------------------------------
        # 1) 동일 정책으로 양측 액션 샘플
        # -------------------------------
        # rollout 버퍼 (양측 전이를 모두 넣기 때문에 길이는 2 * rollout_steps)
        # 경험을 담을 빈 바구니들
        buf_obs, buf_act, buf_logp, buf_rew, buf_done, buf_val = [], [], [], [], [], []
        ep_rewards = []

        # --- 에피소드 통계 (이 rollout 구간 안에서만) ---
        ep_returns: List[float] = []      # 끝난 판마다 PPO 쪽 누적 보상
        ep_wins = 0
        ep_losses = 0
        ep_count = 0
        ep_return_acc = 0.0               # 현재 진행 중 판 누적

        for _ in range(cfg.rollout_steps):
            with torch.no_grad():
                a_p, logp_p, _, v_p = net.sample_action(o_p.unsqueeze(0))
                a_ai, logp_ai, _, v_ai = net.sample_action(o_ai.unsqueeze(0))

            action_player = action_to_coregame(a_p.squeeze(0).cpu().numpy())
            action_ai = action_to_coregame(a_ai.squeeze(0).cpu().numpy())

            out = env.step(action_player, action_ai)

            next_obs_p, next_obs_ai = out["obsPlayer"], out["obsAI"]
            r_p, r_ai, done = float(out["rewardPlayer"]), float(out["rewardAI"]), bool(out["done"])

            if done:
                # step 직후 obs는 보통 종료 직후 상태 (한쪽 hp=0)
                sp = next_obs_p.get("self", {})
                se = next_obs_p.get("enemy", {})
                # player 기준: 내 hp > 0 이면 승
                if cfg.ppo_side == "player":
                    if float(sp.get("hp", 0)) > 0.01:
                        ep_wins += 1
                    else:
                        ep_losses += 1
                else:
                    # PPO = ai → obs_ai 기준 self 가 PPO
                    sa = next_obs_ai.get("self", {})
                    if float(sa.get("hp", 0)) > 0.01:
                        ep_wins += 1
                    else:
                        ep_losses += 1
                ep_returns.append(ep_return_acc)
                ep_count += 1
                ep_return_acc = 0.0

            # -------------------------------
            # 2) player transition 적재
            # -------------------------------
            # 경험치 적재 (Player와 AI 양쪽 데이터를 모두 저장 -> Self-play 핵심)
            buf_obs.append(o_p.detach().cpu()) # detach(): 연산 그래프에서 노드를 분리하여 메모리 해제
            buf_act.append(a_p.squeeze(0).detach().cpu())
            buf_logp.append(logp_p.squeeze(0).detach().cpu())
            buf_rew.append(torch.tensor(r_p, dtype=torch.float32))
            buf_done.append(torch.tensor(done, dtype=torch.float32))
            buf_val.append(v_p.squeeze(0).detach().cpu())

            # -------------------------------
            # 3) AI transition 적재
            # -------------------------------
            buf_obs.append(o_ai.detach().cpu())
            buf_act.append(a_ai.squeeze(0).detach().cpu())
            buf_logp.append(logp_ai.squeeze(0).detach().cpu())
            buf_rew.append(torch.tensor(r_ai, dtype=torch.float32))
            buf_done.append(torch.tensor(done, dtype=torch.float32))
            buf_val.append(v_ai.squeeze(0).detach().cpu())

            # r_p + r_ai: Player와 AI 양쪽 보상을 합쳐서 한 타임스탭의 보상을 계산
            ep_rewards.append(r_p + r_ai)

            global_step += 1

            if done > 0.5:
                obs_p, obs_ai = env.reset(player_color=random.choice(["black", "white"]))
            else:
                obs_p, obs_ai = next_obs_p, next_obs_ai

            o_p = torch.tensor(flatten_obs(obs_p), dtype=torch.float32).to(device)
            o_ai = torch.tensor(flatten_obs(obs_ai), dtype=torch.float32).to(device)

        # --------------------------------------------------------------
        # PPO Update
        # --------------------------------------------------------------
        # rollout 마지막 상태 가치를 예측해서 미래 보상 계산 준비
        with torch.no_grad():
            _, last_v_p = net.forward(o_p.unsqueeze(0))
            _, last_v_ai = net.forward(o_ai.unsqueeze(0))
            last_v = 0.5 * (last_v_p.item() + last_v_ai.item()) # 양측 각각 추정 후 평균 사용(간단화)

        # GAE 계산을 위해 보상과 가치를 스택(stack)으로 묶음
        rews = torch.stack(buf_rew)
        vals = torch.stack(buf_val)
        dones = torch.stack(buf_done)

        # GAE 계산
        adv, ret = compute_gae(rews, vals, dones, last_v, cfg.gamma, cfg.gae_lambda)
        adv = (adv - adv.mean()) / (adv.std() + 1e-8) # 어드벤티지 표준화

        obs_t = torch.stack(buf_obs).to(device)
        act_t = torch.stack(buf_act).to(device).long()
        logp_old_t = torch.stack(buf_logp).to(device)
        adv_t = adv.to(device)
        ret_t = ret.to(device)

        # PPO 업데이트 루프 (에폭만큼 반복)
        n = obs_t.shape[0] # 데이터 개수
        inds = np.arange(n) # 데이터 인덱스 배열
        for _ in range(cfg.epochs):
            np.random.shuffle(inds) # 데이터를 무작위로 섞음
            for s in range(0, n, cfg.minibatch_size):
                mb = inds[s:s+cfg.minibatch_size]

                logp, ent, v = net.evaluate_action(obs_t[mb], act_t[mb]) # 현재 정책으로 행동 평가
                ratio = torch.exp(logp - logp_old_t[mb]) # 현재 정책과 이전 정책의 행동 비교(확률 비율)
                
                # PPO Clip: 정책이 갑자기 너무 많이 변하지 않게 제한
                surr1 = ratio * adv_t[mb] # 좋은 행동의 확률을 높이고 나쁜 행동의 확률을 낮춤
                # clamp(): 확률 비율을 1 ± clip_eps 사이로 제한
                surr2 = torch.clamp(ratio, 1.0 - cfg.clip_eps, 1.0 + cfg.clip_eps) * adv_t[mb] 
                pg_loss = -torch.min(surr1, surr2).mean() # 정책 손실 (행동 개선), 더 작은 쪽 선택

                v_loss = ((v - ret_t[mb]) ** 2).mean()
                ent_loss = ent.mean() # 엔트로피 손실 (다양한 행동 시도 유도)

                # 전체 손실 = 행동 개선 + 판단력 개선 - 탐험 장려(Entropy)
                loss = pg_loss + cfg.vf_coef * v_loss - cfg.ent_coef * ent_loss

                # 역전파
                opt.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(net.parameters(), cfg.max_grad_norm) # 기울기 폭주 방지
                opt.step()

        # --------------------------------------------------------------
        # 저장 및 로그
        # --------------------------------------------------------------
        rollout_idx += 1
        # 10번의 학습 묶음(Rollout)마다 모델 파일(.pt) 저장
        if rollout_idx % cfg.checkpoint_every_rollouts == 0:
            ckpt_path = os.path.join(cfg.checkpoint_dir, f"ppo_selfplay_latest.pt")
            torch.save({
                "model": net.state_dict(),
                "step": global_step,
                "cfg": cfg.__dict__,
                "obs_dim": OBS_DIM,
                "action_dims": ACTION_DIMS,
            }, ckpt_path)
            print(f"[ckpt] step={global_step:,} saved={ckpt_path}")

        mean_ep_r = float(np.mean(ep_returns)) if ep_returns else float("nan")
        win_rate = ep_wins / ep_count if ep_count else float("nan")
        print(
            f"[rollout {rollout_idx}] step={global_step:,} "
            f"mean_step_r={np.mean(ep_rewards):.4f} | "
            f"episodes={ep_count} mean_ep_return={mean_ep_r:.2f} "
            f"win_rate={win_rate:.2%} (W{ep_wins}/L{ep_losses})"
        )

    env.close()

if __name__ == "__main__":
    main()


