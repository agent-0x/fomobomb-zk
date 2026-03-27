# FomoBomb ZK — AI Agent 零知识证明工具包

> AI Agent 本地生成 commitment 和 ZK proof，参与 FomoBomb 大奖抽奖。不需要浏览器、不需要 API、不需要外部服务器。

## 快速开始

```bash
# 1. 克隆仓库
git clone https://github.com/agent-0x/fomobomb-zk
cd fomobomb-zk

# 2. 安装依赖
npm install snarkjs circomlibjs

# 3. 生成 commitment（下注前）
node prove.js generate
# 输出: { secret, nonce, commitment, commitment_hex }

# 4. 调用合约下注
# bet(commitment_hex) + AXON

# 5. 等待 1 个区块后，生成 proof
node prove.js reveal <secret> <nonce> <commitment>
# 输出: { proof_bytes, secret }

# 6. 调用合约揭示
# revealJackpot(proof_bytes, secret)
```

## 工作原理

```
玩家/AI Agent                  FomoBomb 合约                ZK Verifier (0x0813)
    │                              │                            │
    │ 1. 本地生成:                  │                            │
    │    secret, nonce (随机)       │                            │
    │    commitment = Poseidon(s,n) │                            │
    │                              │                            │
    │ 2. bet(commitment) + AXON →  │                            │
    │                              │ 记录 commitment             │
    │                              │ 分配: 25% 奖池 50% 分红     │
    │                              │       20% 大奖 5% 金库      │
    │                              │                            │
    │    ... 等待 1+ 区块 ...       │                            │
    │                              │                            │
    │ 3. 本地生成 ZK proof          │                            │
    │    (证明知道 secret+nonce     │                            │
    │     使得 Poseidon(s,n)       │                            │
    │     == commitment)           │                            │
    │                              │                            │
    │ 4. revealJackpot(proof, s) → │                            │
    │                              │ ── verifyGroth16(proof) ─→ │
    │                              │                    验证通过  │
    │                              │ ←── true ─────────────     │
    │                              │                            │
    │                              │ random = hash(secret,      │
    │                              │               blockhash)   │
    │                              │                            │
    │                              │ if random < jackpotChance: │
    │    ← 大奖！                   │   发放大奖池全部金额         │
```

## 为什么用 ZK？

**普通随机数**（blockhash）可以被验证者操纵：
- 验证者看到你的交易，计算结果，决定是否打包
- 如果你会中奖，验证者可以抢跑或丢弃你的交易

**ZK commit-reveal 方案**不可操纵：
- secret 在下注时就锁定了（commitment = Poseidon(secret, nonce)）
- blockhash 在 secret 提交前就确定了
- 随机数 = hash(secret, blockhash)，双方都无法事后修改
- ZK proof 证明你确实知道 secret，但不泄露 secret 本身

## 文件说明

| 文件 | 大小 | 说明 |
|------|------|------|
| `prove.js` | ~5KB | 主脚本，生成 commitment 和 proof |
| `commitment.wasm` | ~2MB | 电路 WASM，生成 witness 用 |
| `commitment_final.zkey` | ~20MB | Proving key，生成 proof 用 |
| `verification_key.json` | ~1KB | 验证密钥，本地验证用（可选） |

## 链上参数

| | |
|---|---|
| **合约** | FomoBomb V3 (Axon Chain, ID 8210) |
| **ZK 预编译** | `0x0000000000000000000000000000000000000813` |
| **keyId** | `0xcce1fedbac3dccbaf1998bc3364ca71a0cdcb775e3657dea306d83b173a727e7` |
| **电路** | Poseidon(secret, nonce) == commitment |
| **哈希** | Poseidon (BN128 域) |
| **RPC** | `https://mainnet-rpc.axonchain.ai/` |

## AI Agent 完整 Python 示例

```python
import subprocess, json

# 1. 生成 commitment
result = subprocess.run(["node", "prove.js", "generate"], capture_output=True, text=True)
data = json.loads(result.stdout)
secret = data["secret"]
nonce = data["nonce"]
commitment = data["commitment"]
commitment_hex = data["commitment_hex"]

# 2. 调用合约 bet(commitment_hex)
# ... 用 eth_account 签名发送交易 ...

# 3. 等待 1 个区块
import time; time.sleep(10)

# 4. 生成 proof
result = subprocess.run(
    ["node", "prove.js", "reveal", secret, nonce, commitment],
    capture_output=True, text=True
)
reveal_data = json.loads(result.stdout)
proof_bytes = reveal_data["calldata"]["proof_bytes"]

# 5. 调用合约 revealJackpot(proof_bytes, secret)
# ... 签名发送 ...
```

## 注意事项

1. **secret/nonce 必须保密** — 泄露了别人可以替你 reveal
2. **secret/nonce < BN128 域模数** — 脚本自动处理，用 31 字节随机数
3. **commitment 不可重用** — 合约有 `usedCommitments` 防重放
4. **reveal 时限** — blockhash 只有最近 256 个区块可用（约 25 分钟）
5. **Proof 生成时间** — Node.js 约 1-2 秒，浏览器约 2-5 秒

## License

MIT
