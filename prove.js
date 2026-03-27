#!/usr/bin/env node
/**
 * FomoBomb ZK Proof 工具 — AI Agent 本地生成 commitment 和 proof
 *
 * 用法:
 *   node prove.js generate                              → 生成 {secret, nonce, commitment}
 *   node prove.js reveal <secret> <nonce> <commitment>  → 生成 {proof_bytes, secret}
 *   node prove.js bet-and-reveal <private_key> [amount]  → 一键：bet + 等待 + reveal（最简单）
 */

const path = require("path");
const crypto = require("crypto");
const fs = require("fs");

const WASM_PATH = path.join(__dirname, "commitment.wasm");
const ZKEY_PATH = path.join(__dirname, "commitment_final.zkey");

async function loadSnarkjs() {
  try { return require("snarkjs"); }
  catch { console.error("npm install snarkjs"); process.exit(1); }
}

async function loadPoseidon() {
  try { const { buildPoseidon } = require("circomlibjs"); return await buildPoseidon(); }
  catch { console.error("npm install circomlibjs"); process.exit(1); }
}

function randomFieldElement() {
  return BigInt("0x" + crypto.randomBytes(31).toString("hex"));
}

// G2 坐标反转：snarkjs [A0,A1] → Axon 期望 [A1,A0]
function encodeProofForAxon(proof) {
  const vals = [
    proof.pi_a[0], proof.pi_a[1],           // G1 A: X, Y
    proof.pi_b[0][1], proof.pi_b[0][0],     // G2 B: X.A1, X.A0 (反转!)
    proof.pi_b[1][1], proof.pi_b[1][0],     // G2 B: Y.A1, Y.A0 (反转!)
    proof.pi_c[0], proof.pi_c[1],           // G1 C: X, Y
  ];
  return "0x" + vals.map(v => BigInt(v).toString(16).padStart(64, "0")).join("");
}

// ========== generate ==========
async function generate() {
  const poseidon = await loadPoseidon();
  const secret = randomFieldElement();
  const nonce = randomFieldElement();
  const hash = poseidon([secret, nonce]);
  const commitment = poseidon.F.toString(hash);

  const result = {
    secret: secret.toString(),
    nonce: nonce.toString(),
    commitment: commitment,
    commitment_hex: "0x" + BigInt(commitment).toString(16).padStart(64, "0"),
  };

  console.log(JSON.stringify(result, null, 2));

  const filename = `commitment_${Date.now()}.json`;
  fs.writeFileSync(path.join(__dirname, filename), JSON.stringify(result, null, 2));
  console.error(`保存到 ${filename}`);
  return result;
}

// ========== reveal ==========
async function reveal(secretStr, nonceStr, commitmentStr) {
  const snarkjs = await loadSnarkjs();

  console.error("生成 ZK proof...");
  const t0 = Date.now();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    { commitment: commitmentStr, secret: secretStr, nonce: nonceStr },
    WASM_PATH, ZKEY_PATH
  );

  const elapsed = Date.now() - t0;
  console.error(`Proof 完成 (${elapsed}ms)`);

  const proofBytes = encodeProofForAxon(proof);

  console.log(JSON.stringify({
    proof, publicSignals,
    calldata: { proof_bytes: proofBytes, secret: secretStr },
    elapsed_ms: elapsed,
  }, null, 2));
}

// ========== bet-and-reveal: 一键完成 ==========
async function betAndReveal(privateKey, amountAxon = "1") {
  // 动态加载
  let Account, keccak;
  try {
    ({ Account } = require("eth-lib/lib/account"));
  } catch {
    // 用更简单的方式
  }

  const RPC = process.env.RPC || "https://mainnet-rpc.axonchain.ai/";
  const CONTRACT = process.env.CONTRACT || "0xcc4702b224d554b3375175a4ca9f2671034979e4";
  const CHAIN_ID = 8210;

  console.error("这是一键 bet+reveal 参考流程");
  console.error("实际使用请参考 README.md 中的 Python 示例");
  console.error("");
  console.error("步骤:");
  console.error("  1. node prove.js generate → 得到 commitment");
  console.error("  2. 调合约 bet(commitment_hex) 附带 AXON");
  console.error("  3. 等 2 个区块 (~12 秒)");
  console.error("  4. node prove.js reveal <secret> <nonce> <commitment> → 得到 proof_bytes");
  console.error("  5. 调合约 revealJackpot(round, proof_bytes, secret, commitment_hex)");
  console.error("");
  console.error("完整 Python 参考见 example.py");
}

// ========== main ==========
async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "generate" || cmd === "gen" || cmd === "g") {
    await generate();
  } else if (cmd === "reveal" || cmd === "r") {
    if (args.length < 4) {
      console.error("用法: node prove.js reveal <secret> <nonce> <commitment>");
      process.exit(1);
    }
    await reveal(args[1], args[2], args[3]);
  } else if (cmd === "bet-and-reveal" || cmd === "play") {
    await betAndReveal(args[1], args[2]);
  } else {
    console.log(`FomoBomb ZK Proof 工具

用法:
  node prove.js generate                              生成 commitment
  node prove.js reveal <secret> <nonce> <commitment>  生成 ZK proof
  node prove.js play                                  查看完整流程

合约: 0xcc4702b224d554b3375175a4ca9f2671034979e4
链:   Axon (Chain ID 8210)
RPC:  https://mainnet-rpc.axonchain.ai/

依赖: npm install snarkjs circomlibjs`);
  }
}

main().catch(e => { console.error("错误:", e.message); process.exit(1); });
