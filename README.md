# xls6566-evm

XRPL의 **XLS-65 (Single Asset Vault)** 와 **XLS-66 (Lending Protocol)** 을 EVM(Solidity)으로 옮긴 구현체입니다.
예금자 풀, first-loss cover, 분할상환 대출, 채무불이행 손실 배분(waterfall)까지 스펙의 핵심 흐름을 컨트랙트로 재현하고,
Sepolia 테스트넷에서 직접 돌려볼 수 있는 브라우저 데모를 함께 제공합니다.

**라이브 데모**: https://xls6566-evm.vercel.app/ (Sepolia 전용, 실제 자금 없음)

## 구성

| 경로 | 내용 |
|---|---|
| `src/Vault.sol` | XLS-65 Vault. ERC-4626 기반, 유휴 자산 + 대출중 자산을 총자산으로 계산 |
| `src/LoanBroker.sol` | XLS-66 LoanBroker. EIP-712 서명 대출 실행, 상환, impair/default, cover 관리 |
| `src/LoanBrokerHarness.sol` | 리스크 완화용 opt-in 하네스 (집중도 한도 · cover 회수 타임락 · 디폴트 이력 연동 cover 비율) |
| `src/libraries/` | `Amortization` (XLS-66 부록 A-2 상환 공식), `WadMath` |
| `test/` | 단위 · 시나리오 · 인베리언트 · 하네스 테스트 (Foundry) |
| `script/` | 지갑·네트워크 없이 도는 CLI 시나리오 |
| `app/` | React + Vite + ethers v6 데모 앱 |
| `docs/` | 공식 매핑, 하네스 설계, 데모 가이드, 리뷰 노트 |

## 컨트랙트

[Foundry](https://getfoundry.sh)가 필요합니다. 의존성(`forge-std`, OpenZeppelin)은 `lib/`에 포함되어 있어 별도 설치가 필요 없습니다.

```bash
forge build
forge test                                  # 전체 테스트 50개
forge script script/ScenarioA.s.sol -vv     # 정상 상환 시나리오
forge script script/ScenarioB.s.sol -vv     # 채무불이행 시나리오
```

## 데모 앱

```bash
cd app
npm install
npm run dev      # http://localhost:5173
```

MetaMask와 가스용 Sepolia ETH가 필요합니다. 연결 후 셋업을 누르면 예금자·브로커·차입자 역할 지갑이 생성되고
컨트랙트가 배포됩니다. MetaMask 서명은 처음 가스 충전 1회뿐이고, 이후 트랜잭션은 역할 지갑이 자동으로 서명합니다.

| 시나리오 | 내용 |
|---|---|
| A · 정상 렌딩 | 예치 → 대출 → 분할상환 → cover 회수 → 인출, 예금자 이자 수익 |
| B · 채무불이행 | 미상환 → impair → default, cover가 먼저 손실을 흡수하고 나머지는 예금자 부담 |
| C · 집중도 한도 | 하네스 ON이면 대형 단일대출 차단 |
| D · 이력 연동 cover | 디폴트 발생 시 요구 cover 비율 자동 상향 |

자세한 사용법은 [`docs/demo.md`](docs/demo.md), 하네스 설계는 [`docs/harness.md`](docs/harness.md)를 참고하세요.

## 참고

- 역할 지갑의 개인키는 **브라우저 localStorage에만** 저장되는 일회용 테스트 키입니다. 초기화 전에 "남은 가스 회수"로 잔여 ETH를 돌려받으세요.
- 하네스 설정은 배포 시 한 번만 기록됩니다(write-once). 설정을 바꾸려면 재배포가 필요합니다.
- 컨트랙트를 수정하면 `app/src/artifacts.json`을 다시 생성해야 합니다. 방법은 `docs/demo.md`에 있습니다.
- 새 서브도메인에서 지갑 연결과 ETH 전송을 요청하는 구조라 MetaMask가 사이트를 위험으로 표시할 수 있습니다. 테스트넷 전용이며 소스는 이 레포에 전부 공개되어 있습니다.
