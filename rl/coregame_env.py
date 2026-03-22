# --------------------------------------------------------------
# Python PPO가 Node(CoreGame)와 통신하는 환경 래퍼.
# self-play 학습용으로 "양측 관측/보상"을 그대로 제공한다.
# --------------------------------------------------------------
from __future__ import annotations
import json, subprocess # subprocess: 프로세스 실행 및 통신
from this import d
from typing import Dict, Any, Tuple

class CoreGameBridgeEnv:
    # --------------------------------------------------------------
    # 초기화 Node.js 프로세스 생성 및 통신 채널 준비
    # --------------------------------------------------------------
    def __init__(self, node_cmd: str = "node", bridge_path: str = "rl/coregame_bridge.mjs", dt: float = 1/60):
        self.dt = dt
        # subprocess.Popen: 외부 프로그램(Node.js)을 실행함
        self.proc = subprocess.Popen(
            [node_cmd, bridge_path], # 실행 명령어: node rl/coregame_bridge.mjs
            stdin=subprocess.PIPE, # Python이 Node에게 말할 수 있는 통로 (표준 입력)
            stdout=subprocess.PIPE, # Node가 Python에게 말할 수 있는 통로 (표준 출력)
            stderr=subprocess.PIPE, # 에러 메시지를 받는 통로
            text=True, # 데이터를 바이트가 아닌 문자열(String)으로 주고받음
            bufsize=1, # 라인 단위로 즉시 데이터를 보냄 (버퍼링 방지)
        )

    # --------------------------------------------------------------
    # [내부 통신용] Node.js에게 JSON 데이터를 보내고 답변을 한 줄 읽어온다.
    # --------------------------------------------------------------
    def _send(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        assert self.proc.stdin is not None # assert: 조건이 참이 아니면 에러 발생
        assert self.proc.stdout is not None

        # Python 객체를 JSON 문자열로 바꿔서 Node의 입력(stdin)으로 보냄
        self.proc.stdin.write(json.dumps(payload) + "\n") # dumps: JSON 문자열로 변환
        self.proc.stdin.flush() # 버퍼링 방지, 데이터가 통로에 머물지 않고 즉시 전송되도록 밀어냄

        # Node가 처리 후 출력(stdout)한 결과물을 한 줄 읽어움
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("Bridge process closed unexpectedly.")
        # JSON 문자열을 Python 딕셔너리 객체로 변환 (loads: JSON 문자열을 파싱)
        out = json.loads(line)

        # 결과에 ok가 False면 Node 쪽에서 에러가 난 것임
        if not out.get("ok", False):
            raise RuntimeError(f"Bridge error: {out.get('error')}")

        return out

    # --------------------------------------------------------------
    # [게임 리셋] 초기화 또는 새로운 게임 시작
    # --------------------------------------------------------------
    def reset(self, player_color: str = "black") -> Tuple[dict, dict]:
        # Node에게 리셋 명령 전송
        out = self._send({"cmd": "reset", "playerColor": player_color})
        # 플레이어 시점과 AI 시점의 초기 관측 데이터(Observation)를 반환
        return out["obsPlayer"], out["obsAI"]

    # --------------------------------------------------------------
    # [게임 진행] 양측의 액션을 전달하고 다음 프레임의 결과를 받는다.
    # --------------------------------------------------------------
    def step(self, action_player: dict, action_ai: dict):
        out = self._send({
            "cmd": "step",
            "actionPlayer": action_player,
            "actionAI": action_ai,
            "dt": self.dt,
        })
        return out

    # --------------------------------------------------------------
    # [게임 종료] 현재 게임 상태를 저장하고 리셋, 실행 중인 Node.js 프로세스를 안전하게 종료
    # --------------------------------------------------------------
    def close(self):
        try:
            # Node에게 종료하라고 신호를 보냄
            self._send({"cmd": "quit"})
        except Exception:
            pass
        
        # 만약 프로세스가 여전히 살아있다면 강제 종료
        if self.proc.poll() is None: # poll(): 프로세스의 종료 상태를 반환 (None: 아직 실행 중)
            self.proc.kill()
