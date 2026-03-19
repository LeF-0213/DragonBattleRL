// --------------------------------------------------
// 브라우저용 입력 처리
// - 마우스 우클릭: 이동 목표
// - 마우스 좌클릭: 기본 공격(발사 유지)
// - 키보드 W/Q/E/R: 스킬 발동
// --------------------------------------------------
import { Vector2 } from './Vector2.js';

export class Input {
    constructor(canvas) {
        this.canvas = canvas;
        this.mousePos = new Vector2();
        this.leftDown = false;          // 왼쪽 클릭(기본 공격) 유지
        this.rightClickedPos = null;     // 오른쪽 클릭 시 이동 목표 좌표
        this.keys = new Set();           // 눌린 키 (w, q, e, r)

        this._bindEvents();
    }

    // 브라우저 좌표(mouse event)를 캔버스 좌표계로 반환 (리사이즈 대응)
    _getCanvasCoords(evt) {
        const rect = this.canvas.getBoundingClientRect();
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        return new Vector2(
            (evt.clientX - rect.left) * scaleX,
            (evt.clientY - rect.top) * scaleY
        );
    }

    _bindEvents() {
        // 마우스 이동 → 현재 커서 위치 갱신
        this.canvas.addEventListener('mousedown', (e) => {
            this.mousePos = this._getCanvasCoords(e);
        });

        this.canvas.addEventListener('mousedown', (e) => {
            const pos = this._getCanvasCoords(e);
            if (e.button === 0) {
                this.leftDown = true;
            } else if (e.button === 2) {
                this.rightClickedPos = pos;
            }
        });

        this.canvas.addEventListener('mouseup', (e) => {
            if (e.button === 0) this.leftDown = false;
        });

        this.canvas.addEventListener('mousemove', (e) => {
            this.mousePos = this._getCanvasCoords(e);
        });

        // 브라우저 기본 우클릭 메뉴 방지
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });

        window.addEventListener('keydown', (e) => {
            let k = e.key.toLowerCase();

            if (k === 'ㅂ') k = 'q';
            if (k === 'ㅈ') k = 'w';
            if (k === 'ㄷ') k = 'e';
            if (k === 'ㄱ') k = 'r';
            if (k === 'ㅁ') k = 'a';
            if (k === 'ㅇ') k = 'd';
            if (k === 'ㄹ') k = 'f';

            this.keys.add(k);
        });

        window.addEventListener('keyup', (e) => {
            let k = e.key.toLowerCase();

            if (k === 'ㅂ') k = 'q';
            if (k === 'ㅈ') k = 'w';
            if (k === 'ㄷ') k = 'e';
            if (k === 'ㄱ') k = 'r';
            if (k === 'ㅁ') k = 'a';
            if (k === 'ㅇ') k = 'd';
            if (k === 'ㄹ') k = 'f';

            this.keys.delete(k);
        });
    }

    // 우클릭 목표 한 번 소비 (한 프레임에 한 번만 처리)
    consumeRightClick() {
        const p = this.rightClickedPos;
        this.rightClickedPos = null;
        return p;
    }

    // 특정 키 입력 한 번 소비 (스킬 발동 시)
    consumeKey(key) {
        key = key.toLowerCase();
        if (this.keys.has(key)) {
            this.keys.delete(key);
            return true;
        }
        return false;
    }

    // 특정 키가 눌려있는지 확인
    isKeyDown(key) {
        return this.keys.has(key.toLowerCase());
    }
}