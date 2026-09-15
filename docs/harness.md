# LoanBroker 하네스 (Sixth Sense DeFi Article §4.2)

XLS-66 신용대출의 세 리스크 — 기관이 손실흡수 비율을 스스로 정함, 한 건 디폴트가 공탁 전체에
미치지 못함, 수수료가 예금자와 동순위라 "마진 구간"이 생김 — 을 완화하는 **방어 층**.
XLS-66 원장 규격은 못 바꾸므로, EVM 포크의 `LoanBroker` 세 함수 앞단에 통제를 얹는다.

## 세 통제

| 통제 | 적용 함수 (스펙명) | 공식 / 동작 |
|---|---|---|
| **① Concentration limit** | `originate` (LoanSet) | `L_new ≤ α × max(DebtTotal+L_new, D_floor)`, `borrowerDebt+L_new ≤ α_b × max(...)` |
| **② Recovery timelock** | `coverWithdraw` (LoanBrokerCoverWithdraw) | 환수가능 = `CoverAvailable − MinCover − Σ_{최근 T_lock} DefaultAmount×CRM_eff` |
| **③ History-linked cover rate** | `setCoverRates`·`originate`·`_minCoverRequired` (LoanBrokerSet) | `CRM_eff = max(CRM_set, CRM_floor + λ × DefaultRate)`, `DefaultRate = ΣDefault/Σ실행원금` |

## 구조 (내장 믹스인)

- **`src/LoanBrokerHarness.sol`** (abstract): 통제 로직·추적 상태(`borrowerDebt`,
  `totalOriginatedPrincipal`, `totalDefaultedAmount`, 디폴트 기록). 브로커 상태는
  `virtual` getter(`_hDebtTotal`/`_hCrmSetWad`/`_hCrmFloorWad`)로 받는다.
- **`LoanBroker is LoanBrokerHarness, …`** — getter override + 훅 호출.
  - `originate`: `_harnessCheckConcentration` → `requiredCover`에 `_effectiveCRM()` →
    `_harnessOnOriginate`
  - `coverWithdraw`: `lockedCover()`만큼 추가 예약
  - `pay`/`closeLoan`/`default_`: `_harnessSubBorrowerDebt`; `default_`은 `_harnessOnDefault`
  - `_minCoverRequired()`가 `_effectiveCRM()`을 쓰므로 ③이 cover 충분성·환수·default 흡수
    상한에 자동 전파.

## 활성화 — opt-in · write-once · admin-gated

```solidity
initHarness(bool enabled, uint256 alpha, uint256 alphaBorrower,
            uint256 debtFloor, uint256 lockDuration, uint256 lambda)
```
- `DEFAULT_ADMIN_ROLE` 전용(브로커 owner가 아님 — 기관이 자기 한도를 못 끄게), **1회성**(이후 동결).
- 호출 안 하면 `harnessEnabled=false` → 전 검사 no-op → 기존 LoanBroker와 100% 동일.
- 값 단위: `alpha`/`alphaBorrower`/`lambda`는 WAD 분수(1e18=100%/1.0), `debtFloor`는 native,
  `lockDuration`은 초. `CRM_floor`는 배포 시 `coverRateFloorWad` 재사용.

## 관측용 view
`effectiveCoverRateMinimum()`, `coverWithdrawable()`, `defaultRateWad()`,
`borrowerDebt(addr)`, `lockedCover()`, `harnessEnabled()`.

## 설계 메모
- **DefaultRate = 누적**(총디폴트/총실행원금). 글의 윈도우 Σ_T는 후속 옵션.
- **borrower 캡에도 D_floor 적용**: 글 공식(`Σ ≤ α_b × DebtTotal`)은 기점에서 DebtTotal≈0이라
  첫 대출이 항상 걸리므로, 단일대출 캡과 동일하게 `max(basis, D_floor)`를 기준으로 삼았다.
- **effective CRM 100% 상한**: `CRM > 100%`는 무의미하므로 캡.

## 테스트 & 데모
```
forge test --match-path test/Harness.t.sol -vv   # ①②③ + write-once (6개)
forge test                                        # 전체 50개 (하네스 off라 기존 44 무변)
```
- 데모(React, `app/`): 배포 시 **"하네스 적용"** 토글 → `initHarness` 활성화.
  - **시나리오 C**: 대형 단일대출 차단(①). 하네스 OFF면 실행되어 집중 리스크 노출.
  - **시나리오 D**: 대출 2건 중 1건 디폴트(디폴트율 50%) → 유효 CRM 10%→50% 자동 상향(③).
    (데모 배포는 `CRM_floor=0`·λ=1.0 → `max(10%, 0%+1.0×50%)=50%`. 테스트는 `CRM_floor=10%`라 60%.)
  - 원장에 유효 CRM(③)·디폴트율·cover 회수가능(②) 실시간 표시.

## 남은 스펙 경계
하네스는 FLC(공탁의 대출규모 연동)를 대체하지 않고, **공탁이 손실 흡수에도 연동되도록** 만든다.
심사·최종 책임이 오프체인에 남는 XLS-66 경계는 유지하되, 기관이 손실 상한을 0으로 설정할 여지를 줄인다.
