# FomoBomb ZK 集成踩坑记录

从零到链上 ZK 验证通过，我们踩了每一个能踩的坑。这份文档记录完整过程，给后来者避坑。

## 最终架构

```
玩家本地                           Axon 链上
├─ Poseidon(secret, nonce)        ├─ FomoBomb V3 合约
│  = commitment                   │  bet(commitment) → 存储
├─ snarkjs/rapidsnark             │  revealJackpot(proof, secret)
│  生成 Groth16 proof             │     → 调 0x0813 预编译验证
└─ 发送 TX (公共 RPC)             └─ random = hash(secret, timestamp)
```

## 踩坑清单

### 坑 1: blockhash() 在 Axon 链上返回 0

**现象:** `require(blockhash(revealBlock) != 0)` 永远 revert

**原因:** Axon 是 Cosmos SDK + EVM 链，EVM 的 `blockhash()` opcode 返回全零。这是 Cosmos EVM 的已知限制。

**解法:** 改用 `block.timestamp + block.number` 作为熵源。secret 在 bet 时已锁定，timestamp 在 reveal 时才确定，双方不能同时控制。

```solidity
// 错误
bytes32 entropy = blockhash(revealBlock);
require(entropy != bytes32(0));  // 永远 revert

// 正确
uint256 random = uint256(keccak256(abi.encodePacked(
    secret, block.timestamp, block.number
)));
```

---

### 坑 2: Verification Key 注册格式 — JSON vs 二进制

**现象:** proof 本地验证通过，链上 `verifyGroth16()` 始终返回 false

**原因:** `registerVerifyingKey(bytes vk)` 我们传了 `verification_key.json` 的原始 JSON 字节。但链上 `VerifyGroth16BN254()` 期望的是二进制编码：

```
[4 bytes: numPublicInputs (uint32 BE)]
[64 bytes: Alpha (G1)]
[128 bytes: Beta (G2)]
[128 bytes: Gamma (G2)]
[128 bytes: Delta (G2)]
[64 * (N+1) bytes: IC/K points (G1)]
```

`registerVerifyingKey` 只存不验，所以注册不报错，但验证时 parse 失败直接返回 false。

**解法:** 把 snarkjs 的 verification_key.json 转成二进制格式再注册：

```python
import struct

def g1_to_bytes(point):
    x, y = int(point[0]), int(point[1])
    return x.to_bytes(32, 'big') + y.to_bytes(32, 'big')

def g2_to_bytes(point):
    # 注意: Axon 期望 [X.A1, X.A0, Y.A1, Y.A0]（见坑3）
    xa0, xa1 = int(point[0][0]), int(point[0][1])
    ya0, ya1 = int(point[1][0]), int(point[1][1])
    return xa1.to_bytes(32,'big') + xa0.to_bytes(32,'big') + \
           ya1.to_bytes(32,'big') + ya0.to_bytes(32,'big')

binary_vk = struct.pack('>I', vk['nPublic'])
binary_vk += g1_to_bytes(vk['vk_alpha_1'])
binary_vk += g2_to_bytes(vk['vk_beta_2'])
binary_vk += g2_to_bytes(vk['vk_gamma_2'])
binary_vk += g2_to_bytes(vk['vk_delta_2'])
for ic in vk['IC']:
    binary_vk += g1_to_bytes(ic)
```

注册费用: **100 AXON**（存入预编译，不退）。keyId = SHA256(binary_vk)。

---

### 坑 3: G2 点坐标顺序 — snarkjs vs Axon

**现象:** VK 格式正确了，但 proof 验证还是 INVALID

**原因:** BN254 G2 点有两个 Fp2 坐标（X 和 Y），每个 Fp2 有两个分量（A0, A1）。不同实现的排列顺序不同：

| | snarkjs 输出 | Axon 预编译期望 |
|---|---|---|
| G2.X | `[A0, A1]` | `[A1, A0]` |
| G2.Y | `[A0, A1]` | `[A1, A0]` |

Axon 源码 `UnmarshalG2` (groth16.go:141):
```go
p.X.A1.SetBytes(data[0:32])   // A1 在前
p.X.A0.SetBytes(data[32:64])  // A0 在后
```

**解法:** proof 编码时把 pi_b 的每对坐标反转：

```javascript
// 错误
vals = [a[0],a[1], b[0][0],b[0][1], b[1][0],b[1][1], c[0],c[1]]

// 正确 — b 的每对反转
vals = [a[0],a[1], b[0][1],b[0][0], b[1][1],b[1][0], c[0],c[1]]
```

**同样适用于 VK 中的 G2 点（Beta, Gamma, Delta）！**

---

### 坑 4: public inputs 数量变化需要重新 trusted setup

**现象:** 修改电路增加 public input 后，旧的 wasm/zkey 生成的 proof 只有 1 个 signal

**原因:** 电路从 `public [commitment]` 改成 `public [commitment, secret]` 后，必须重新编译 + 重新 setup：

```bash
circom commitment.circom --r1cs --wasm --sym -o build -l node_modules
npx snarkjs groth16 setup build/commitment.r1cs pot12_final.ptau commitment_0000.zkey
echo "entropy" | npx snarkjs zkey contribute commitment_0000.zkey commitment_final.zkey
npx snarkjs zkey export verificationkey commitment_final.zkey verification_key.json
```

新的 zkey 会产生新的 keyId，需要重新注册（又花 100 AXON）。

---

### 坑 5: commitment 绑定 sender 防抄袭

**现象:** Codex review 发现别人可以抄你的 commitment，用你的 proof 重复抽奖

**原因:** 如果链上只存原始 commitment，攻击者看到你的 commitment 后复制到自己的 bet，等你 reveal 后用同样的 proof 开奖。

**解法:** 合约存 `boundCommitment = keccak256(commitment, msg.sender)`，绑定到发送者：

```solidity
// bet() 中
bytes32 boundCommitment = keccak256(abi.encodePacked(commitment, msg.sender));
commitments[roundId][msg.sender] = CommitInfo({ hash: boundCommitment, ... });

// revealJackpot() 中
bytes32 expectedBound = keccak256(abi.encodePacked(originalCommitment, msg.sender));
require(c.hash == expectedBound, "commitment mismatch");

// ZK 验证用原始 commitment（不是 bound 版本）
publicInputs[0] = uint256(originalCommitment);
```

---

### 坑 6: jackpot 快照防等池子涨了再 reveal

**现象:** Codex review 发现玩家可以算出自己中没中，然后等大奖池涨了再 reveal

**原因:** 概率和奖金都用实时 `jackpot` 值计算，但 random 在 bet 后就确定了。

**解法:** bet 时快照概率 + jackpotEpoch 机制：

```solidity
struct CommitInfo {
    bytes32 hash;
    uint256 revealBlock;
    uint256 chanceAtBet;    // 快照
    uint256 jpEpochAtBet;   // 大奖被领后 epoch 变，旧票作废
}

// reveal 时用快照概率
if (random % 10000 < c.chanceAtBet) { ... }
require(c.jpEpochAtBet == jackpotEpoch, "epoch changed");
```

---

### 坑 7: snarkjs 在低配服务器上极慢

**现象:** sniper VPS 上 proof 生成需要 60+ 秒甚至超时，CPU load 飙到 5+

**原因:** snarkjs 是纯 JS/WASM 实现，CPU 密集。VPS 同时跑节点 + 挖矿脚本，CPU 竞争严重。

**解法:** 用 **rapidsnark**（C++ 实现），同样的 zkey + witness，速度快 100 倍：

```bash
# 安装 rapidsnark
wget https://github.com/iden3/rapidsnark/releases/download/v0.0.8/rapidsnark-linux-x86_64-v0.0.8.zip
unzip rapidsnark-linux-x86_64-v0.0.8.zip

# 两步生成 proof
# Step 1: witness (node, ~70ms)
npx snarkjs wtns calculate commitment.wasm input.json witness.wtns

# Step 2: proof (rapidsnark, ~10ms)
./prover commitment_final.zkey witness.wtns proof.json public.json
```

总计 **80ms** vs snarkjs 的 30-60 秒。

---

### 坑 8: SSH 传变量导致数据截断

**现象:** bet 用的 commitment 和 reveal 用的不一致，导致 "commitment mismatch"

**原因:** 通过 bash 变量在 SSH 之间传递大数字（200+ 位 decimal）时，shell 扩展/转义可能截断或改变值。

**解法:** 所有数据在**同一个 Python 进程**内传递，不通过 bash 变量。commitment 保存到 JSON 文件，后续步骤从文件读取。

---

### 坑 9: 公共 RPC eth_call 行为不一致

**现象:** `eth_call` 模拟 reveal 返回 "expired"，但实际链上才过了几个块

**原因:** 公共 RPC 可能是负载均衡的多个节点，`eth_call` 模拟时的 block context 可能和实际出块节点不同。`blockhash()` 在模拟环境中返回 0。

**解法:** 不做 `eth_call` 预检查，直接发交易。交易在链上执行时 context 是正确的。（后来改成 timestamp 后这个坑也绕过了）

---

### 坑 10: 多次部署导致 commitment 残留

**现象:** bet 返回 "reveal first" — 当前 round 有未 reveal 的 commitment

**原因:** 调试过程中多次 bet 但没 reveal，commitment 卡在合约里。256 块内无法清除。

**解法:** 合约已有 `clearExpiredCommitment(round)` 和 `clearStaleCommitment(round)`。但测试时最简单的办法是用一个**全新的钱包**。

---

## 最终参数

| 参数 | 值 |
|------|-----|
| 合约 | `0xcc4702b224d554b3375175a4ca9f2671034979e4` |
| ZK 预编译 | `0x0000000000000000000000000000000000000813` |
| keyId | `0x11259c9d5e8e2294802e61537a995d4ebb994103a2b712fc70508855f11989c6` |
| 电路 | Poseidon(secret, nonce) == commitment, 2 public inputs |
| Proof 编码 | 256 bytes: G1(64) + G2(128, 坐标反转) + G1(64) |
| VK 编码 | 二进制: 4 + G1 + G2×3 + G1×(N+1) = 644 bytes |
| 熵源 | keccak256(secret, block.timestamp, block.number) |
| Proof 生成 | rapidsnark 80ms / snarkjs 30s |

## Codex Review 记录

| 轮次 | 发现 | 修复 |
|------|------|------|
| R1 | secret 没绑定 proof | secret 作为 public input |
| R1 | reveal 时 blockhash 已知 | 改 timestamp |
| R1 | commitment 可被抄 | boundCommitment |
| R1 | 跨轮 commitment 丢失 | targetRound 参数 |
| R2 | 等池子涨了再 reveal | chanceAtBet 快照 |
| R2 | proof 不绑定身份 | commitment 绑定 sender |
| R3 | 中奖票等大奖池重填 | jackpotEpoch |
| R3 | 过期 commitment 锁死 | clearExpiredCommitment |
| R4 | 清除逻辑可绕过 | block.number > revealBlock+256 |
| R4 | epoch 变化锁死 | clearStaleCommitment + auto-clear |
| R5 | PASS | — |

## 时间线

- 设计 commit-reveal + ZK 方案
- 编写 Poseidon 电路（circom）
- 注册 VK（JSON 格式）→ **坑2**
- proof 验证失败 → 发现 G2 编码问题 → **坑3**
- 修复编码仍失败 → 发现 VK 格式问题 → 重新注册（二进制）
- blockhash 返回 0 → **坑1** → 改 timestamp
- snarkjs 太慢 → **坑7** → 改 rapidsnark
- Codex 5 轮审计修复 6 个安全漏洞
- 最终验证通过 ✅
