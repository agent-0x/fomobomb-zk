#!/usr/bin/env python3
"""
FomoBomb ZK — AI Agent 最简参考实现

只需要: pip install eth-account eth-utils
ZK 部分: npm install snarkjs circomlibjs (在 fomobomb-zk 目录下)

如果本地有 rapidsnark，proof 生成只要 10ms。没有也行，snarkjs 大概 30s。
"""

import json, subprocess, time, os, sys, glob
from eth_account import Account
from eth_utils import keccak, to_checksum_address

# ============ 配置（改成你自己的） ============
RPC = "https://mainnet-rpc.axonchain.ai/"
CONTRACT = to_checksum_address("0xcc4702b224d554b3375175a4ca9f2671034979e4")
CHAIN_ID = 8210
PRIVATE_KEY = os.environ.get("PRIVATE_KEY", "你的私钥")
ZK_DIR = os.path.dirname(os.path.abspath(__file__))  # prove.js 所在目录

# rapidsnark 路径（可选，没有就用 snarkjs，慢但能用）
RAPIDSNARK = os.environ.get("RAPIDSNARK", "")

# ============ 工具函数 ============
ADDR = Account.from_key(PRIVATE_KEY).address

def rpc(method, params):
    for _ in range(5):
        try:
            r = subprocess.run(["curl", "-s", "-m", "20", RPC, "-X", "POST",
                "-H", "Content-Type: application/json",
                "-d", json.dumps({"jsonrpc": "2.0", "method": method, "params": params, "id": 1})],
                capture_output=True, text=True)
            d = json.loads(r.stdout)
            if "result" in d:
                return d
        except:
            pass
        time.sleep(3)
    raise Exception("RPC 连不上")

def send_tx(data, value=0):
    nonce = int(rpc("eth_getTransactionCount", [ADDR, "latest"])["result"], 16)
    tx = {
        "nonce": nonce, "to": CONTRACT, "data": data, "value": value,
        "gas": 800000, "gasPrice": 1000000000, "chainId": CHAIN_ID,
    }
    signed = Account.sign_transaction(tx, PRIVATE_KEY)
    raw = signed.raw_transaction.hex()
    if not raw.startswith("0x"):
        raw = "0x" + raw
    return rpc("eth_sendRawTransaction", [raw])["result"]

def wait_receipt(tx_hash, timeout=30):
    for _ in range(timeout // 3):
        rec = rpc("eth_getTransactionReceipt", [tx_hash])
        if rec.get("result"):
            return rec["result"]
        time.sleep(3)
    raise Exception("TX 超时")

def encode_proof_for_axon(proof):
    """G2 坐标反转：snarkjs [A0,A1] → Axon 期望 [A1,A0]"""
    a, b, c = proof["pi_a"], proof["pi_b"], proof["pi_c"]
    vals = [a[0], a[1], b[0][1], b[0][0], b[1][1], b[1][0], c[0], c[1]]
    return "0x" + "".join(hex(int(v))[2:].zfill(64) for v in vals)

# ============ 主流程 ============
def play():
    bal = int(rpc("eth_getBalance", [ADDR, "latest"])["result"], 16) / 1e18
    print(f"钱包: {ADDR[:10]}... 余额: {bal:.2f} AXON")
    if bal < 1.1:
        print("余额不足 1 AXON"); return

    # === Step 1: 生成 commitment ===
    print("\n[1] 生成 commitment...")
    r = subprocess.run(["node", os.path.join(ZK_DIR, "prove.js"), "generate"],
                        capture_output=True, text=True, cwd=ZK_DIR, timeout=15)
    gen = json.loads(r.stdout)
    secret = gen["secret"]
    nonce = gen["nonce"]
    commitment = gen["commitment"]
    commitment_hex = gen["commitment_hex"]
    print(f"    commitment: {commitment_hex[:20]}...")
    print(f"    保存好 secret 和 nonce！")

    # === Step 2: Bet ===
    print("\n[2] 投注 1 AXON...")
    bet_sel = keccak(b"bet(bytes32)")[:4].hex()
    tx = send_tx("0x" + bet_sel + commitment_hex[2:], int(1e18))
    print(f"    tx: {tx[:20]}...")
    rec = wait_receipt(tx)
    if int(rec.get("status", "0x0"), 16) != 1:
        print("    投注失败!"); return
    print("    投注成功!")

    round_id = int(rpc("eth_call", [{"to": CONTRACT.lower(),
        "data": "0x" + keccak(b"roundId()")[:4].hex()}, "latest"])["result"], 16)

    # === Step 3: 等待 ===
    print("\n[3] 等待 2 个区块 (12 秒)...")
    time.sleep(12)

    # === Step 4: 生成 proof ===
    print("\n[4] 生成 ZK proof...")

    # 方式 A: rapidsnark（快，推荐）
    if RAPIDSNARK and os.path.exists(RAPIDSNARK):
        with open("/tmp/zk_input.json", "w") as f:
            f.write(json.dumps({"commitment": commitment, "secret": secret, "nonce": nonce}))

        # witness
        t0 = time.time()
        subprocess.run(["node", os.path.join(ZK_DIR, "node_modules/snarkjs/build/cli.cjs"),
            "wtns", "calculate", os.path.join(ZK_DIR, "commitment.wasm"),
            "/tmp/zk_input.json", "/tmp/zk_witness.wtns"],
            capture_output=True, text=True, timeout=60, cwd=ZK_DIR)
        # proof
        subprocess.run([RAPIDSNARK, os.path.join(ZK_DIR, "commitment_final.zkey"),
            "/tmp/zk_witness.wtns", "/tmp/zk_proof.json", "/tmp/zk_public.json"],
            capture_output=True, text=True, timeout=10)
        elapsed = int((time.time() - t0) * 1000)

        with open("/tmp/zk_proof.json") as f:
            proof = json.load(f)
        proof_bytes = encode_proof_for_axon(proof)
        print(f"    rapidsnark: {elapsed}ms")

    # 方式 B: snarkjs（慢但通用）
    else:
        r2 = subprocess.run(["node", os.path.join(ZK_DIR, "prove.js"), "reveal",
            secret, nonce, commitment],
            capture_output=True, text=True, cwd=ZK_DIR, timeout=120)
        if r2.returncode != 0:
            print(f"    proof 失败: {r2.stderr[:100]}"); return
        rv = json.loads(r2.stdout)
        proof = rv["proof"]
        proof_bytes = encode_proof_for_axon(proof)
        print(f"    snarkjs: {rv['elapsed_ms']}ms")

    # === Step 5: Reveal 抽大奖 ===
    print("\n[5] Reveal 抽大奖...")
    sel = keccak(b"revealJackpot(uint256,bytes,uint256,bytes32)")[:4].hex()
    rh = hex(round_id)[2:].zfill(64)
    oh = hex(128)[2:].zfill(64)
    sh = hex(int(secret))[2:].zfill(64)
    ch = commitment_hex[2:]
    pr = proof_bytes[2:]
    pl = hex(len(pr) // 2)[2:].zfill(64)
    pp = pr.ljust(((len(pr) // 2 + 31) // 32) * 64, "0")
    calldata = "0x" + sel + rh + oh + sh + ch + pl + pp

    tx2 = send_tx(calldata)
    print(f"    tx: {tx2[:20]}...")
    rec2 = wait_receipt(tx2)
    status = int(rec2.get("status", "0x0"), 16)

    if status == 1:
        jp_topic = keccak(b"JackpotWin(address,uint256,uint256)").hex()
        for log in rec2.get("logs", []):
            if jp_topic in log.get("topics", [""])[0]:
                prize = int(log["data"][2:66], 16) / 1e18
                print(f"\n    🎉 大奖!!! {prize:.2f} AXON")
                break
        else:
            print("\n    ✅ ZK 验证成功! 这次没中大奖，下次继续。")
    else:
        print("\n    ❌ Reveal 失败")

    # === Step 6: 领钱 ===
    print("\n[6] 查看待提取...")
    pw_sel = keccak(b"pendingWithdrawals(address)")[:4].hex()
    pw = int(rpc("eth_call", [{"to": CONTRACT.lower(),
        "data": "0x" + pw_sel + ADDR[2:].lower().zfill(64)}, "latest"])["result"], 16) / 1e18
    if pw > 0:
        print(f"    待提取: {pw:.4f} AXON")
        print(f"    调 withdraw() 提取")
    else:
        print(f"    暂无待提取")

if __name__ == "__main__":
    if PRIVATE_KEY == "你的私钥":
        print("请设置环境变量: export PRIVATE_KEY=你的私钥")
        print("然后运行: python3 example.py")
        print("")
        print("或者分步执行:")
        print("  1. node prove.js generate")
        print("  2. 调合约 bet(commitment_hex)")
        print("  3. 等 12 秒")
        print("  4. node prove.js reveal <secret> <nonce> <commitment>")
        print("  5. 调合约 revealJackpot(round, proof_bytes, secret, commitment_hex)")
    else:
        play()
