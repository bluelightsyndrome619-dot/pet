import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { HistorySummarySchema, VisitSummarySchema } from "./schemas.js";

// 既定は元の MediKataru と同じ Sonnet 5.5（コスト重視）。精度を上げたいときは ANTHROPIC_MODEL=claude-opus-5-5
export const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
// 考える深さ。low / medium / high から選ぶ。上げるほど精度とコストが上がる
const EFFORT = process.env.ANTHROPIC_EFFORT || "medium";

export const aiEnabled = () => Boolean(process.env.ANTHROPIC_API_KEY);

const VISIT_PROMPT = `あなたは日本の動物病院で使われる「説明内容の翻訳・要約アシスタント」です。
獣医師・動物看護師が、ペット（犬・猫・うさぎなど）の飼い主であるご家族に行った説明の文字起こしを受け取り、次の2種類を同時に作成します。

1. family: ご家族向けの要約
   - 読み手は、医療の知識がないご家族（子どもや高齢の方を含む）です。中学生でもわかる言葉で、短い文で書きます。
   - ペットのことは「この子」または入力された名前で呼びます。
   - 医療用語・略語（例: 外耳炎、膿皮症、ALT、BUN、エコー、エリザベスカラー）は、headline・explanation・key_points・
     home_care・warning_signs・next_schedule のどの項目でも、その項目で最初に出てくるところで
     「膿皮症（皮膚に細菌が増えて、ぶつぶつやかさぶたができる状態）」のようにカッコで言い換えます。
     画面では項目ごとに別の枠で表示され、箇条書きだけを読む人も多いため、ほかの項目で言い換え済みでも省略しません。
   - 薬は medicines に、名前を会話どおりに残し、何のための薬か・あげ方を書きます。
   - 言い換えた用語は glossary にもまとめます。
   - 画面はスマホで縦に読まれるため、短くまとめます。同じ内容を複数の項目に書きません。
     key_points・home_care・warning_signs・next_schedule は1項目1文にします。
   - 「です・ます」調で、ご家族に語りかける口調にします。不安をあおる表現は避け、事実は弱めずに伝えます。
   - warning_signs には、獣医師が「こんな様子なら連絡・受診を」と言った症状・状態だけを、1項目に1つずつ入れます。

2. record: 受診歴のための記録
   - 複数回の受診をあとで並べて「これまでの受診歴」をまとめるための、事実だけの簡潔な記録です。
   - 薬の名前・量・回数・期間、検査の数値、体重は会話どおりに書き、推測で補いません。

絶対に守ること:
- 文字起こしに無い情報（診断名、薬、数値、予定、一般的な獣医学知識による補足）を付け足さない。
  例外は医療用語の言い換え（カッコ内と glossary.plain）だけで、用語そのものの意味は一般的な知識で短く説明してよい。
  ただし言い換えの中に、この子の状態・原因・見通しについての推測を入れない。
- 人間用の薬や食べ物をあげてよいかのような助言は、会話に無い限り書かない。
- 音声認識の誤変換と思われる箇所や、聞き取れない・矛盾する箇所は、推測で埋めずに
  family.confirm_with_vet と record.uncertainties に書く。
- 該当する内容が会話に無い配列は空配列、文字列は「記載なし」とする。
- 獣医師の発言とご家族の発言が混在していても、内容から判断して整理する。`;

const HISTORY_PROMPT = `あなたは日本の動物病院で使われる「受診歴のまとめアシスタント」です。
1匹のペットについて、これまでの受診ごとの記録（日付順）と、ご家族が撮った写真の記録（部位・日付・メモ）を受け取り、
ご家族が経過を見返したり、次の受診やほかの病院で見せたりするための「これまでの受診歴」のまとめを作ります。

- 読み手はご家族です。やさしい言葉で、短い文で書きます。医療用語は、各項目で最初に出てくるところでカッコで言い換えます。
- 入力の記録に無い情報（診断名、薬、数値、予定、一般的な獣医学知識による補足、見通しの推測）は付け足しません。
- 記録どうしが食い違う場合は、新しい記録を優先し、食い違いを questions_for_next_visit に書きます。
- 写真の記録は、メモに書かれた事実だけを使います（写真そのものは見えていません）。
- current_medicines には、最新の記録の時点で続いていると読み取れる薬だけを入れます。続いているか不明なら questions_for_next_visit に書きます。
- 該当する内容が無い配列は空配列にします。`;

export class SummarizeError extends Error {}

async function callClaude(system, userContent, schema) {
  const client = new Anthropic();
  try {
    const response = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: userContent }],
      output_config: { effort: EFFORT, format: betaZodOutputFormat(schema) },
      // 安全分類器に止められた場合はサーバー側で推奨モデルに自動で切り替える
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    if (response.stop_reason === "refusal") {
      throw new SummarizeError("AIがこの内容のまとめを行えませんでした。内容を確認して、もう一度お試しください。");
    }
    if (response.stop_reason === "max_tokens") {
      throw new SummarizeError("内容が長すぎて、まとめが途中で切れました。説明を分けて記録してください。");
    }
    if (!response.parsed_output) {
      throw new SummarizeError("まとめた結果を読み取れませんでした。もう一度お試しください。");
    }
    return {
      result: response.parsed_output,
      model: response.model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  } catch (error) {
    if (error instanceof SummarizeError) throw error;
    if (error instanceof Anthropic.AuthenticationError) {
      throw new SummarizeError("ANTHROPIC_API_KEY が正しくありません。");
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new SummarizeError("AIの利用が混み合っています。少し待ってから、もう一度お試しください。");
    }
    if (error instanceof Anthropic.APIError) {
      throw new SummarizeError(`AIの呼び出しに失敗しました（${error.status ?? "接続エラー"}）。`);
    }
    throw error;
  }
}

const clip = (v, n) => String(v ?? "").slice(0, n);

// ---------- 1回の受診 ----------

export async function summarizeVisit(input) {
  const pet = input.pet || {};
  const userContent = [
    `ペット: ${clip(pet.name, 40) || "不明"}（${clip(pet.species, 20) || "種類不明"}${pet.breed ? `・${clip(pet.breed, 40)}` : ""}）`,
    `受診日: ${clip(input.date, 20) || "不明"}`,
    `場面: ${clip(input.scene, 40) || "不明"}`,
    `病院: ${clip(input.clinic, 60) || "不明"}`,
    `説明者: ${clip(input.vet, 60) || "不明"}`,
    "",
    "<transcript>",
    clip(input.transcript, 60000),
    "</transcript>",
  ].join("\n");

  if (!aiEnabled()) {
    return { result: demoVisit(input.transcript), model: "demo (APIキー未設定)", inputTokens: 0, outputTokens: 0 };
  }
  return callClaude(VISIT_PROMPT, userContent, VisitSummarySchema);
}

// ---------- これまでの受診歴 ----------

export async function summarizeHistory(input) {
  const pet = input.pet || {};
  const visits = (input.visits || []).slice(-60);
  const photos = (input.photos || []).slice(-120);
  const userContent = [
    `ペット: ${clip(pet.name, 40) || "不明"}（${clip(pet.species, 20) || "種類不明"}${pet.breed ? `・${clip(pet.breed, 40)}` : ""}）`,
    pet.birthday ? `生年月日: ${clip(pet.birthday, 20)}` : "",
    pet.note ? `ご家族のメモ: ${clip(pet.note, 400)}` : "",
    "",
    "<visits>",
    JSON.stringify(
      visits.map((v) => ({ date: clip(v.date, 20), clinic: clip(v.clinic, 60), scene: clip(v.scene, 40), record: v.record })),
      null,
      1,
    ),
    "</visits>",
    "",
    "<photos>",
    JSON.stringify(photos.map((p) => ({ date: clip(p.date, 20), part: clip(p.part, 30), memo: clip(p.memo, 300) })), null, 1),
    "</photos>",
  ]
    .filter((l) => l !== null)
    .join("\n");

  if (!aiEnabled()) {
    return { result: demoHistory(visits), model: "demo (APIキー未設定)", inputTokens: 0, outputTokens: 0 };
  }
  return callClaude(HISTORY_PROMPT, userContent, HistorySummarySchema);
}

// ---------- APIキーなしでも画面の流れを確認できるようにするダミー。内容の要約は行わない ----------

const NOTICE = "【お試し表示】AIの設定がないため、AIによるまとめは行われていません。";

export function demoVisit(transcript = "") {
  const sentences = String(transcript)
    .split(/(?<=[。！？!?\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const head = sentences.slice(0, 3);
  return {
    title: (sentences[0] ?? "説明の記録").replace(/^[^：:]{1,8}[：:]/, "").slice(0, 20),
    family: {
      headline: NOTICE,
      explanation: head.join(""),
      key_points: head,
      home_care: [],
      medicines: [],
      warning_signs: [],
      next_schedule: [],
      glossary: [],
      confirm_with_vet: ["お試し表示のため、内容は必ず獣医師に確認してください。"],
    },
    record: {
      one_liner: NOTICE,
      reason: "記載なし",
      findings: "記載なし",
      diagnosis: "記載なし",
      treatment: "記載なし",
      medications: [],
      tests: [],
      vaccines_preventives: [],
      weight: "記載なし",
      next_visit: "記載なし",
      uncertainties: ["お試し表示のため要約未実施"],
    },
  };
}

export function demoHistory(visits = []) {
  return {
    overview: `${NOTICE}記録は${visits.length}件あります。下の「受診の流れ」は記録をそのまま並べたものです。`,
    ongoing: [],
    current_medicines: [],
    timeline: visits.map((v) => ({ date: v.date || "日付なし", event: v.record?.one_liner || v.title || "受診" })),
    preventive_care: [],
    cautions: [],
    weight_trend: "記録なし",
    upcoming: [],
    questions_for_next_visit: ["お試し表示のため、内容は必ず獣医師に確認してください。"],
  };
}
