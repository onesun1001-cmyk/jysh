# 🔐 Secure Wedding Invitation

정보보호 컨셉 모바일 청첩장. 단일 `index.html` + `images/` 정적 사이트로, GitHub Pages에 그대로 배포됩니다.

## 수정 방법
`index.html` 안의 `CONFIG` 블록만 고치면 됩니다.
- 이름·부모님·연락처, 예식 일시(`date`), 예식장(`venue`, 위도/경도)
- 사진: `images/`에 넣고 `mainPhoto`, `photos` 에 경로 입력
- 계좌, 참석 회신 링크(`rsvpUrl`)
- 서약문은 `POLICY` 배열

## 배포
Settings → Pages → Source: `Deploy from a branch` → `main` / `(root)`
