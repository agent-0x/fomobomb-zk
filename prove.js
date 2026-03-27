#!/usr/bin/env node
/**
 * FomoBomb ZK Proof 工具 — AI Agent 本地生成 commitment 和 proof
 *
 * 用法:
 *   node prove.js generate                              → 生成 {secret, nonce, commitment}
 *   node prove.js reveal <secret> <nonce> <commitment>  → 生成 {proof, calldata}
 *   node prove.js verify <commitment> <proof_json>      → 本地验证 proof
 */

const path = require("path");
const crypto = require("crypto");

const WASM_PATH = path.join(__dirname, "commitment.wasm");
const ZKEY_PATH = path.join(__dirname, "commitment_final.zkey");

// BN128 域模数 — secret/nonce 必须小于此值
const BN128_PRIME = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

async function loadSnarkjs() {
  try {
    return require("snarkjs");
  } catch {
    console.error("错误: 需要安装 snarkjs");
    console.error("  npm install snarkjs");
    process.exit(1);
  }
}

async function loadPoseidon() {
  try {
    const { buildPoseidon } = require("circomlibjs");
    return await buildPoseidon();
  } catch {
    console.error("错误: 需要安装 circomlibjs");
    console.error("  npm install circomlibjs");
    process.exit(1);
  }
}

function randomFieldElement() {
  // 31 字节随机数，保证 < BN128 域模数
  const bytes = crypto.randomBytes(31);
  return BigInt("0x" + bytes.toString("hex"));
}

// ========== generate: 生成 commitment ==========
async function generate() {
  const poseidon = await loadPoseidon();

  const secret = randomFieldElement();
  const nonce = randomFieldElement();

  const hash = poseidon([secret, nonce]);
  const commitment = poseidon.F.toString(hash);

  // 输出 JSON，AI Agent 直接解析
  const result = {
    secret: secret.toString(),
    nonce: nonce.toString(),
    commitment: commitment,
    commitment_hex: "0x" + BigInt(commitment).toString(16).padStart(64, "0"),
  };

  console.log(JSON.stringify(result, null, 2));

  // 同时保存到文件（方便后续 reveal 使用）
  const fs = require("fs");
  const filename = `commitment_${Date.now()}.json`;
  fs.writeFileSync(filename, JSON.stringify(result, null, 2));
  console.error(`\n已保存到 ${filename} — reveal 时需要 secret 和 nonce`);

  return result;
}

// ========== reveal: 生成 ZK proof ==========
async function reveal(secretStr, nonceStr, commitmentStr) {
  const snarkjs = await loadSnarkjs();
  const fs = require("fs");

  // 检查文件存在
  if (!fs.existsSync(WASM_PATH)) {
    console.error("错误: 找不到 " + WASM_PATH);
    console.error("请确保 commitment.wasm 在当前目录");
    process.exit(1);
  }
  if (!fs.existsSync(ZKEY_PATH)) {
    console.error("错误: 找不到 " + ZKEY_PATH);
    console.error("请确保 commitment_final.zkey 在当前目录");
    process.exit(1);
  }

  console.error("生成 ZK proof...");
  const startTime = Date.now();

  const { proof, publicSignals } = await snarkjs.groth16.fullProve(
    {
      secret: secretStr,
      nonce: nonceStr,
    },
    WASM_PATH,
    ZKEY_PATH
  );

  const elapsed = Date.now() - startTime;
  console.error(`Proof 生成完成 (${elapsed}ms)`);

  // 验证 public signal 匹配 commitment
  if (publicSignals[0] !== commitmentStr) {
    console.error("警告: publicSignals[0] !== commitment");
    console.error("  publicSignals[0]:", publicSignals[0]);
    console.error("  commitment:", commitmentStr);
  }

  // 编码 proof 为合约需要的 bytes 格式 (8 个 uint256 打包)
  const proofEncoded = encodeProof(proof);

  const result = {
    proof: proof,
    publicSignals: publicSignals,
    // 合约调用参数
    calldata: {
      proof_bytes: proofEncoded,
      secret: secretStr,
      // revealJackpot(bytes proof, uint256 secret) 的完整 calldata
      function_sig: "revealJackpot(bytes,uint256)",
    },
    elapsed_ms: elapsed,
  };

  console.log(JSON.stringify(result, null, 2));
  return result;
}

// 将 snarkjs proof 编码为合约 bytes 格式
function encodeProof(proof) {
  const vals = [
    proof.pi_a[0],
    proof.pi_a[1],
    proof.pi_b[0][0],
    proof.pi_b[0][1],
    proof.pi_b[1][0],
    proof.pi_b[1][1],
    proof.pi_c[0],
    proof.pi_c[1],
  ];

  // 每个值转为 32 字节 hex
  const hex = vals.map((v) => BigInt(v).toString(16).padStart(64, "0")).join("");
  return "0x" + hex;
}

// ========== verify: 本地验证 proof ==========
async function verify(commitmentStr, proofJsonStr) {
  const snarkjs = await loadSnarkjs();
  const fs = require("fs");

  const vkeyPath = path.join(__dirname, "verification_key.json");
  if (!fs.existsSync(vkeyPath)) {
    console.error("错误: 找不到 verification_key.json");
    console.error("可以用 snarkjs zkey export verificationkey 导出");
    process.exit(1);
  }

  const vkey = JSON.parse(fs.readFileSync(vkeyPath, "utf-8"));
  const proof = JSON.parse(proofJsonStr);
  const publicSignals = [commitmentStr];

  const valid = await snarkjs.groth16.verify(vkey, publicSignals, proof);
  console.log(JSON.stringify({ valid }));
  return valid;
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
  } else if (cmd === "verify" || cmd === "v") {
    if (args.length < 3) {
      console.error('用法: node prove.js verify <commitment> \'{"pi_a":...}\'');
      process.exit(1);
    }
    await verify(args[1], args[2]);
  } else {
    console.log(`FomoBomb ZK Proof 工具

用法:
  node prove.js generate                              生成 commitment (下注前)
  node prove.js reveal <secret> <nonce> <commitment>  生成 ZK proof (下注后)
  node prove.js verify <commitment> <proof_json>      本地验证 proof

流程:
  1. generate → 得到 {secret, nonce, commitment}
  2. 调用合约 bet(commitment_hex) 下注
  3. 等待至少 1 个区块
  4. reveal → 得到 {proof_bytes, secret}
  5. 调用合约 revealJackpot(proof_bytes, secret) 揭示

依赖:
  npm install snarkjs circomlibjs`);
  }
}

main().catch((e) => {
  console.error("错误:", e.message);
  process.exit(1);
});
