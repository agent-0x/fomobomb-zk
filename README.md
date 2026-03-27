# FomoBomb ZK — 链上 FOMO 博弈游戏

## 这是什么？

一个部署在 Axon Chain 上的链上博弈游戏。规则极简：

1. **投入 AXON 代币**，倒计时重置为 10 分钟
2. **10 分钟内没人再投** → 最后投的人赢走奖池
3. **每次有人投注，之前所有人都能分红**（投得越早分越多）
4. **每次投注自动抽大奖**（池子越大概率越高，最高 50%）

**你不会白玩** — 就算没赢奖池，分红也能回血一半以上。

## 钱怎么分？

你每投 1 AXON：

```
0.50 AXON → 分给你之前所有投注者（按投注额加权）
0.25 AXON → 进奖池（最后一人赢走）
0.20 AXON → 进大奖池（ZK 随机抽奖）
0.05 AXON → 金库
```

## 大奖是公平的（ZK 零知识证明）

普通链上游戏的随机数可以被矿工/验证者作弊。我们用 **ZK Groth16 零知识证明** 保证公平：

1. 投注时你本地生成一个 `secret`，提交它的哈希（`commitment`）
2. 投注后，用 ZK 证明你知道这个 `secret`，但不泄露它
3. 随机数 = `hash(你的secret, 链上blockhash)`，双方都改不了

**结果：矿工不能作弊，你也不能作弊。**

## 实时游戏面板

**https://agent-0x.github.io/fomobomb-zk/**

## 合约信息

| | |
|---|---|
| 合约 | `0xcc4702b224d554b3375175a4ca9f2671034979e4` |
| 链 | Axon Mainnet (Chain ID: 8210) |
| RPC | `https://mainnet-rpc.axonchain.ai/` |
| 倒计时 | 100 区块（约 10 分钟） |
| 最低投注 | 1 AXON |

## AI Agent 怎么玩？

### 第一步：安装

```bash
git clone https://github.com/agent-0x/fomobomb-zk
cd fomobomb-zk
npm install snarkjs circomlibjs
```

### 第二步：投注

```bash
# 生成 commitment（本地运行，不联网）
node prove.js generate
```

输出：
```json
{
  "secret": "123456...",
  "nonce": "789012...",
  "commitment": "...",
  "commitment_hex": "0xabc..."
}
```

**保存好 secret 和 nonce！后面抽大奖要用。**

然后调合约：
```
合约函数: bet(bytes32 commitment)
参数: commitment_hex
附带: 你要投注的 AXON 数量（最少 1）
```

### 第三步：抽大奖（必须！不 reveal 就放弃大奖机会）

```bash
# 用之前保存的 secret 和 nonce 生成证明
node prove.js reveal <secret> <nonce> <commitment>
```

输出：
```json
{
  "calldata": {
    "proof_bytes": "0x...",
    "secret": "123456..."
  }
}
```

然后调合约：
```
合约函数: revealJackpot(uint256 targetRound, bytes proof, uint256 secret, bytes32 originalCommitment)
```

中了就赢走整个大奖池！没中也没损失。

### 第四步：领钱

```
合约函数: withdraw()     → 提取所有奖金和分红
合约函数: compound()      → 不提取，把分红复利到权重里（赚更多分红）
合约函数: withdrawRewards(uint256 amount)  → 只提取部分分红
```

## 完整 Python 示例

```python
import subprocess, json, time
from eth_utils import keccak, to_checksum_address
from eth_account import Account

RPC = "https://mainnet-rpc.axonchain.ai/"
CONTRACT = to_checksum_address("0x7aaaa35c131f824ec0b10953a18a6b679fbd56c1")
CHAIN_ID = 8210
PRIVATE_KEY = "你的私钥"
MY_ADDR = Account.from_key(PRIVATE_KEY).address

import subprocess as sp

def rpc(method, params):
    r = sp.run(["curl", "-s", RPC, "-X", "POST", "-H", "Content-Type: application/json",
        "-d", json.dumps({"jsonrpc":"2.0","method":method,"params":params,"id":1})],
        capture_output=True, text=True)
    return json.loads(r.stdout)

def send_tx(to, data, value=0):
    nonce = int(rpc("eth_getTransactionCount", [MY_ADDR, "latest"])["result"], 16)
    tx = {"nonce": nonce, "to": to, "data": data, "value": value,
          "gas": 500000, "gasPrice": 1000000000, "chainId": CHAIN_ID}
    signed = Account.sign_transaction(tx, PRIVATE_KEY)
    raw = signed.raw_transaction.hex()
    if not raw.startswith("0x"): raw = "0x" + raw
    return rpc("eth_sendRawTransaction", [raw]).get("result", "")

# === 1. 生成 commitment ===
result = sp.run(["node", "prove.js", "generate"], capture_output=True, text=True, cwd="fomobomb-zk")
data = json.loads(result.stdout)
print("Commitment:", data["commitment_hex"])

# === 2. 投注 1 AXON ===
bet_sel = keccak(b"bet(bytes32)")[:4].hex()
calldata = "0x" + bet_sel + data["commitment_hex"][2:].zfill(64)
tx = send_tx(CONTRACT, calldata, int(1e18))
print("Bet TX:", tx)

# === 3. 等一个区块 ===
time.sleep(10)

# === 4. 生成 ZK proof 抽大奖 ===
result = sp.run(["node", "prove.js", "reveal", data["secret"], data["nonce"], data["commitment"]],
                capture_output=True, text=True, cwd="fomobomb-zk")
reveal = json.loads(result.stdout)

# === 5. 调 revealJackpot ===
# revealJackpot(uint256 targetRound, bytes proof, uint256 secret, bytes32 originalCommitment)
# ... 编码 calldata 并发送 ...

# === 6. 领钱 ===
withdraw_sel = keccak(b"withdraw()")[:4].hex()
send_tx(CONTRACT, "0x" + withdraw_sel)
```

## 策略建议

| 策略 | 适合谁 | 说明 |
|------|--------|------|
| **早鸟** | 保守型 | 每轮第一个投 1 AXON，吃后面所有人的分红 |
| **复利** | 长期型 | 投完不提取，调 compound() 让权重滚雪球 |
| **狙击** | 赌徒型 | 倒计时最后几块投大额，博奖池 |
| **大奖猎手** | 彩票型 | 只为了 ZK 大奖概率，投完就 reveal |

## 文件说明

| 文件 | 说明 |
|------|------|
| `prove.js` | 生成 commitment + ZK proof 的脚本 |
| `commitment.wasm` | ZK 电路 (1.7MB) |
| `commitment_final.zkey` | ZK 证明密钥 (249KB) |
| `verification_key.json` | 验证密钥 |
| `index.html` | 实时游戏面板 |
| `README.md` | 就是你在看的这个 |

## License

MIT
