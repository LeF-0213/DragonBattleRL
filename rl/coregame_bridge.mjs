// Python 학습 프로세스가 stdin/stdout JSONL로 CoreGame을 조작하기 위한 브릿지.
/*
학습은 Python(PPO)이 편하고,
실제 게임 로직은 JS CoreGame에 이미 있으니,
둘을 소켓 없이 간단히 붙이기 위해서입니다.
즉, 브릿지는 번역기/중계기 역할

Python이 reset/step/quit 명령 보냄
브릿지가 CoreGame 실행
결과(obs/reward/done)를 Python으로 반환
*/

// node:readline => 노드 내장 모듈로, 콘솔 입력 처리를 위한 모듈
import readline from 'node:readline';
// Node에서 ESM로 동작하도록 package.json(type: module)을 추가했기 때문에
// named export 방식으로 CoreGame을 로딩한다.
import { CoreGame } from '../src/core/CoreGame.js';

const game = new CoreGame(); // CoreGame 인스턴스 생성

// 표준 입출력을 인터페이스로 생성(CLI 환경에서 데이터를 주고받기 위함)
const rl = readline.createInterface({
    input: process.stdin, // 외부(Python 등)에서 보내는 데이터를 읽음
    output: process.stdout, // 외부로 데이터를 보냄
    terminal: false, // 터미널 모드 비활성화(콘솔 입출력 그대로 사용)
});

function normalizeAction(a = {}) {
    // CoreGame이 기대하는 액션 키를 모두 채워준다.
    return {
        moveX: Number.isFinite(a.moveX) ? a.moveX : 0,
        moveY: Number.isFinite(a.moveY) ? a.moveY : 0,
        shoot: !!a.shoot, // !! => 안전하게 boolean으로 변환하기 위함
        useQ: !!a.useQ,
        useW: !!a.useW,
        useE: !!a.useE,
        useR: !!a.useR,
        useD: !!a.useD,
        useF: !!a.useF,
        // E/R 조준 벡터(없어도 CoreGame 내부에서 백업 방향 사용)
        dirX: Number.isFinite(a.dirX) ? a.dirX : undefined,
        dirY: Number.isFinite(a.dirY) ? a.dirY : undefined,
    };
}

function write(obj) {
    // JSON 객체를 문자열로 바꾸어 표준 출력(stdout)으로 한 줄씩 내보내는 유틸리티 함수
    process.stdout.write(`${JSON.stringify(obj)}\n`);
}

// 입력 스트림에 한줄(Line)이 들어올 때마다 실행 (JSONL 방식)
rl.on('line', (line) => {
    try {
        const msg = JSON.parse(line); // 입력받은 문자열을 JSON 객체로 파싱

        if (msg.cmd === 'reset') {
            game.reset({ playerColor: msg.playerColor || 'black'});

            // 리셋 후의 초기 상태(관찰 데이터)를 응답
            write({
                ok: true,
                obsPlayer: game.getObservationFor('player'),
                obsAI: game.getObservationFor('ai'),
            });
            return;
        }

        // 게임 진행 명령 (step)
        if (msg.cmd === 'step') {
            // 프레임 간격(초) 설정(기본 60fps)
            const dt = Number.isFinite(msg.dt) ? msg.dt : 1 / 60;

            // 양측 액션을 정규화
            const actionPlayer = normalizeAction(msg.actionPlayer);
            const actionAI = normalizeAction(msg.actionAI);

            // 게임 상태 업데이트
            // out에는 보상(reward), 종료 여부(done), 상태(observation) 등을 담음
            const out = game.step(actionPlayer, actionAI, dt);

            // 결과 출력
            write({ ok: true, ...out});
            return;
        }

        // 종료 명령
        if (msg.cmd === 'quit') {
            write({ ok: true });
            process.exit(0); // 정상 종료(0)
        }

        // 정의되지 않은 명령어가 들어온 경우
        write({ ok: false, error: `Unknown command: ${msg.cmd}` });
    } catch (e) {
        // JSON 파싱 오류나 게임 로직 에러 처리
        write({ ok: false, error: String(e)});
    }
});