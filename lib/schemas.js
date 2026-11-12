import { z } from "zod/v4";

// 構造化出力で必ず全項目を返させるため、optional は使わず空配列・「記載なし」で表す

// ---------- 1回の受診の説明 ----------

// ご家族向け：動物病院での説明を、だれにでもわかる言葉にしたもの
export const FamilySummarySchema = z.object({
  headline: z.string().describe("今日の説明を一文で。やさしい言葉で。40文字程度まで"),
  explanation: z.string().describe("説明の全体像。やさしい言葉で2〜3文。数値の細部は key_points に書き、ここでは繰り返さない"),
  key_points: z.array(z.string()).describe("覚えておいてほしい大事な点。4項目まで、1項目1文。医療用語は各項目の中でカッコで言い換える"),
  home_care: z.array(z.string()).describe("おうちですること・生活で気をつけること（食事、散歩、シャンプー、エリザベスカラーなど）。1項目1文"),
  medicines: z
    .array(
      z.object({
        name: z.string().describe("薬の名前（会話どおり）。わからなければ「名前の説明なし」"),
        purpose: z.string().describe("何のための薬か、やさしい言葉で。会話に無ければ「記載なし」"),
        how_to_give: z.string().describe("あげ方・回数・期間・つけ方（会話どおり）。会話に無ければ「記載なし」"),
      }),
    )
    .describe("処方・変更された飲み薬・塗り薬・点眼・点耳など"),
  warning_signs: z.array(z.string()).describe("こんな様子なら早めに病院へ連絡・受診、と説明された症状・状態。1項目に1つ。まとめの文は入れない"),
  next_schedule: z.array(z.string()).describe("次回の受診・再診・検査・ワクチンなどの予定"),
  glossary: z
    .array(z.object({ term: z.string(), plain: z.string() }))
    .describe("会話に出た医療用語と、そのやさしい言い換え（用語の一般的な意味のみ。この子個別の推測は書かない）"),
  confirm_with_vet: z
    .array(z.string())
    .describe("会話から読み取れない・あいまいで、獣医師に確認してほしい点。おうちでのケアや治療に関わるものだけ、3項目まで"),
});

// 受診歴のための記録：あとで「これまでの受診歴」をまとめるときの材料
export const VisitRecordSchema = z.object({
  one_liner: z.string().describe("この受診を一行で（例: 右耳の外耳炎、点耳薬を開始）"),
  reason: z.string().describe("受診のきっかけ・ご家族が気づいた症状。会話に無ければ「記載なし」"),
  findings: z.string().describe("診察・検査でわかったこと（数値は会話どおり）。会話に無ければ「記載なし」"),
  diagnosis: z.string().describe("獣医師の見立て・診断名。会話に無ければ「記載なし」"),
  treatment: z.string().describe("その日に行った処置・治療と今後の方針。会話に無ければ「記載なし」"),
  medications: z.array(z.string()).describe("処方・変更・中止された薬（薬の名前・量・回数・期間は会話どおり）"),
  tests: z.array(z.string()).describe("その日に行った、または予定の検査"),
  vaccines_preventives: z.array(z.string()).describe("ワクチン・フィラリア・ノミダニなどの予防"),
  weight: z.string().describe("体重（会話どおり）。会話に無ければ「記載なし」"),
  next_visit: z.string().describe("次回の受診予定。会話に無ければ「記載なし」"),
  uncertainties: z.array(z.string()).describe("聞き取り不明瞭・矛盾・要確認の点"),
});

export const VisitSummarySchema = z.object({
  title: z.string().describe("一覧に出す短いタイトル（20文字以内、例: 耳のかゆみと点耳薬）"),
  family: FamilySummarySchema,
  record: VisitRecordSchema,
});

// ---------- これまでの受診歴 ----------

export const HistorySummarySchema = z.object({
  overview: z.string().describe("これまでの経過の全体像。やさしい言葉で2〜4文"),
  ongoing: z
    .array(z.string())
    .describe("今も続いている・様子を見ている症状や病気。会話に出た事実だけ。1項目1文"),
  current_medicines: z
    .array(z.string())
    .describe("最新の記録の時点で続いていると読み取れる薬（名前とあげ方）。中止された薬は入れない"),
  timeline: z
    .array(z.object({ date: z.string().describe("受診日（入力どおり）"), event: z.string().describe("その日の出来事を1文で") }))
    .describe("受診の流れ。古い順"),
  preventive_care: z.array(z.string()).describe("ワクチン・フィラリア・ノミダニなど予防の記録（日付つき）"),
  cautions: z.array(z.string()).describe("アレルギー・合わなかった薬・苦手な処置など、次の受診で伝えたい注意点。記録にあるものだけ"),
  weight_trend: z.string().describe("体重の変化（記録にある数値だけ）。記録が無ければ「記録なし」"),
  upcoming: z.array(z.string()).describe("これからの予定（最新の記録にあるもの）"),
  questions_for_next_visit: z.array(z.string()).describe("次の受診で獣医師に聞くとよいこと。記録のあいまいな点や、写真の記録から確認したい点。3項目まで"),
});

// ---------- 日々の経過（次の受診で獣医師に見せる） ----------

export const DailySummarySchema = z.object({
  overview: z.string().describe("この期間の様子の全体像。2〜3文。獣医師がすぐ把握できるよう、変化があった点を先に書く"),
  energy_appetite: z.string().describe("元気・食欲の変化（日付つき）。記録が無ければ「記録なし」"),
  weight: z.string().describe("体重の変化（記録どおりの数値と日付）。記録が無ければ「記録なし」"),
  water: z.string().describe("飲んだ水の量の様子（記録どおりの数値）。記録が無ければ「記録なし」"),
  stool: z.string().describe("うんちの状態と回数の様子（日付つき）。記録が無ければ「記録なし」"),
  food_supplements: z.string().describe("食べているフード・サプリと、その変更（日付つき）。記録が無ければ「記録なし」"),
  walks: z.string().describe("散歩の様子（回数・時間）。犬でない、または記録が無ければ「記録なし」"),
  events: z
    .array(z.object({ date: z.string().describe("日付（入力どおり）"), event: z.string().describe("出来事を1文で") }))
    .describe("日記や写真のメモにある、受診で伝えたほうがよい出来事（吐いた、かゆがった、元気がなかった、など）。古い順。8項目まで"),
  questions_for_vet: z.array(z.string()).describe("次の受診で獣医師に聞くとよいこと。記録から読み取れる気がかりな点。3項目まで"),
});
