const { classifyEmail } = require('./classify_email');
const assert = require('assert');

const refSet = new Set(['967', '1181', '888']); // 888は実データに実在するテスト用REF#

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log('OK  ', name); }
  else { fail++; console.log('FAIL', name, 'actual=', JSON.stringify(actual), 'expected=', JSON.stringify(expected)); }
}

// 空文字/null
check('空文字/null',
  classifyEmail({ subject: '', body: null, attachmentNames: [], refSet }),
  { isImport: false, reason: 'none', matched: '' });

// KICコードのみ
check('KICコードのみ(件名)',
  classifyEmail({ subject: 'KIC1162_AT の件', body: '', attachmentNames: [], refSet }).isImport,
  true);
check('KICコードのみ・reason',
  classifyEmail({ subject: 'KIC1162_AT の件', body: '', attachmentNames: [], refSet }).reason,
  'kic_code');

// REF#のみ(実在)
check('実在REF#(#888)',
  classifyEmail({ subject: '御見積 #888 の件', body: '', attachmentNames: [], refSet }),
  { isImport: true, reason: 'ref_no', matched: '888' });

// 実在しないREF#
check('実在しないREF#(#999999)',
  classifyEmail({ subject: '#999999 について', body: '', attachmentNames: [], refSet }).isImport,
  false);

// #888(カラーコード想定/誤検出対策確認) - 前後に英数字が続く場合は境界外でマッチしないこと
check('16進カラーコード風#888888(桁数が違う・後続に数字が続くため単独の#888としてはマッチしない)',
  classifyEmail({ subject: '', body: 'color:#888888;background:#888888', attachmentNames: [], refSet }).isImport,
  false);

// 全角のKICコード
check('全角のKICコード(ＫＩＣ１１６２)',
  classifyEmail({ subject: 'ＫＩＣ１１６２＿ＡＴ の件', body: '', attachmentNames: [], refSet }).isImport,
  true);

// 引用返信内にKICコードがある場合
check('引用返信内のKICコード',
  classifyEmail({ subject: 'Re: ご相談', body: '\n\n> 2026/07/01 田中様:\n> KIC0967_JF の件ですが、\n> よろしくお願いします', attachmentNames: [], refSet }).isImport,
  true);

// 本文6,000文字超
const longBody = 'x'.repeat(6000) + ' KIC0967_JF';
check('本文6000文字超でもKICコードを検出',
  classifyEmail({ subject: '', body: longBody, attachmentNames: [], refSet }).isImport,
  true);
const longBodyNoCode = 'x'.repeat(6000);
check('本文6000文字超・該当なし',
  classifyEmail({ subject: '', body: longBodyNoCode, attachmentNames: [], refSet }).isImport,
  false);

// 名簿・ルーミングリスト(日英)
check('ルーミングリスト(日本語)',
  classifyEmail({ subject: 'ルーミングリストの送付', body: '', attachmentNames: [], refSet }),
  { isImport: true, reason: 'name_list', matched: 'ルーミングリスト' });
check('rooming list(英語)',
  classifyEmail({ subject: 'Final Rooming List attached', body: '', attachmentNames: [], refSet }).reason,
  'name_list');
check('name list単語境界(surname listingは誤検出しない)',
  classifyEmail({ subject: 'surname listing update', body: '', attachmentNames: [], refSet }).isImport,
  false);

// 広告メールの典型例(該当なし想定)
check('広告メール(該当なし)',
  classifyEmail({ subject: '【ASKUL】お荷物の配達が完了しました', body: 'いつもご利用ありがとうございます', attachmentNames: [], refSet }).isImport,
  false);

// D-1/D-2追加ケース(2026-07-28指示分)
check('スペース区切り「KIC 770＿JJ」(D-1)',
  classifyEmail({ subject: 'Re: Pre-stay (前泊のお願い）　KIC 770＿JJ', body: '', attachmentNames: [], refSet }),
  { isImport: true, reason: 'kic_code', matched: 'KIC 770_JJ' });

check('数字なしシリーズ名「KIC_JF」(D-2ホワイトリスト)',
  classifyEmail({ subject: 'KIC_JF&LJシリーズ アゴーラリージェンシー大阪堺', body: '', attachmentNames: [], refSet }),
  { isImport: true, reason: 'kic_code', matched: 'KIC_JF' });

check('自社名「株式会社KIC」のみ(誤検出しないこと)',
  classifyEmail({ subject: '株式会社KIC 御中', body: 'いつもお世話になっております。', attachmentNames: [], refSet }).isImport,
  false);

check('自社名「KIC Travel」のみ(誤検出しないこと)',
  classifyEmail({ subject: 'Greetings from KIC Travel', body: '', attachmentNames: [], refSet }).isImport,
  false);

// STEP3: KICコード直後が「年」「年度」の場合は不一致にする(否定先読み)。
check('「KIC 2026年」は不一致',
  classifyEmail({ subject: 'KIC 2026年の実績について', body: '', attachmentNames: [], refSet }).isImport,
  false);
check('「KIC 2026年度」は不一致',
  classifyEmail({ subject: 'KIC 2026年度の契約について', body: '', attachmentNames: [], refSet }).isImport,
  false);
check('「KIC 2026」単独は一致のまま',
  classifyEmail({ subject: 'KIC 2026 の件です', body: '', attachmentNames: [], refSet }).isImport,
  true);
check('「KIC 770」は一致のまま(年号ガードの影響を受けない)',
  classifyEmail({ subject: 'Re: Pre-stay (前泊のお願い）　KIC 770＿JJ', body: '', attachmentNames: [], refSet }).isImport,
  true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
