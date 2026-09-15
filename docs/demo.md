# XLS-65/66 EVM 렌딩 데모 (React)

실제 `Vault` + `LoanBroker` 컨트랙트를 **Sepolia 테스트넷**에서 구동하는 브라우저 dApp.
예금자·브로커·차입자가 **각자 별도 계정**(앱 생성·자동서명)으로 실제 트랜잭션을 주고받고,
숫자는 온체인에서 읽어온 실제 잔액이다. 실제 자금 아님 (가스만 무료 faucet ETH).

프로젝트: `app/` (Vite + React + TypeScript + ethers v6).

## 실행

```bash
cd app
npm run dev      # 개발: http://localhost:5173 (MetaMask, Sepolia)
npm run build    # 정적 빌드 → app/dist (GitHub Pages/Netlify/Vercel 어디든)
```

MetaMask 필요, 가스용 Sepolia ETH는 [faucet](https://sepoliafaucet.com)에서 무료. dUSD는 앱에서 자동 지급.

## 사용 흐름

1. **지갑 연결** (Sepolia로 전환).
2. **계정 만들고 배포** — 역할 지갑 3개 생성 + 컨트랙트 배포 + dUSD 지급 (MetaMask 서명 1회).
   - **"하네스 적용" 체크** 시 §4.2 LoanBroker 하네스가 함께 활성화된다(`docs/harness.md`).
3. 파라미터를 바꾸거나 **▶ 기본값으로 실행**.
4. 데모 후 **남은 가스 회수**로 임시지갑의 잔여 ETH를 내 지갑으로 회수.

## 시나리오

| 시나리오 | 내용 |
|---|---|
| **A · 정상 렌딩** | 예치 → 대출 → 분할상환 → cover 회수 → 인출. 예금자가 이자 수익 |
| **B · 채무불이행** | 차입자 미상환 → impair → default(first-loss waterfall) → 예금자 손실. cover 흡수 + 예금자 부담 = 원금 |
| **C · 집중도 한도 (하네스 ①)** | 대형 단일대출 시도 → 하네스 ON이면 차단(집중 리스크 방지), OFF면 실행 |
| **D · 이력 연동 공탁 (하네스 ③)** | 대출 2건 중 1건 디폴트 → 유효 CoverRateMinimum 자동 상향(10%→50%) |

각 단계마다 자금흐름 애니메이션 + 제목/설명 박스. 하네스 ON이면 원장에 유효 CRM(③)·디폴트율·cover 회수가능(②) 지표가 표시된다.

## 참고
- 역할 지갑 키는 브라우저 localStorage에만 저장되는 일회용 테스트 키. **다른 URL/포트에서 열면
  이전 배포가 안 보인다**(localStorage는 URL별).
- 컨트랙트를 바꾸면 아티팩트를 재생성해야 한다:
  ```bash
  forge build
  python3 - <<'PY'
  import json
  out={}
  for n,f in [('token','out/LendingDemo.s.sol/DemoUSD.json'),('vault','out/Vault.sol/Vault.json'),('broker','out/LoanBroker.sol/LoanBroker.json')]:
      d=json.load(open(f)); bc=d['bytecode']['object']
      out[n]={'abi':d['abi'],'bytecode':bc if bc.startswith('0x') else '0x'+bc}
  open('app/src/artifacts.json','w').write(json.dumps(out))
  PY
  ```

## CLI 시나리오 (지갑·네트워크 없이)
```bash
forge script script/ScenarioA.s.sol -vv   # 정상
forge script script/ScenarioB.s.sol -vv   # 디폴트
```
로컬 EVM에서 즉시 실행, 단계별 원장 스냅샷 출력.
