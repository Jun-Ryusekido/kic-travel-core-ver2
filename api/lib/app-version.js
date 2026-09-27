// 画面(index.html)のコードの版による書き込みガード(2026-09-25 JUN決定)。
//
// 背景: 古い版のindex.htmlを開いたままのタブは、デプロイ後もリロードされるまで古いコードのまま
// 動き続ける(このアプリには版の確認・自動リロードの仕組みが無かった)。RLS有効化(バッチ1)の後に
// 旧コードの画面から保存すると、読み取りが0件扱いになったまま保存・全削除→再挿入が走り、既存の
// 明細を消してしまう経路がある(SESSION_NOTES.md「RLS有効化SQLの実行時の注意」参照)。
// 「全員に再読み込みしてもらう」運用だけに頼らず、書き込みAPIの側で古い画面からの書き込みを拒否する。
//
// 仕組み:
// - index.htmlは定数APP_VERSION(YYYYMMDDNN形式の整数)を持ち、/api/への全リクエストに
//   X-App-Versionヘッダーとして付けて送る(index.htmlのwindow.fetchラッパー参照)。
// - サーバーは、書き込み系actionについて、ヘッダーが無い・または MIN_WRITE_APP_VERSION より
//   古いリクエストを 426 で拒否する(読み取り系actionは拒否しない。理由はtable-crud.jsの
//   APP_VERSION_EXEMPT_ACTIONSのコメント参照)。
// - MIN_WRITE_APP_VERSION は「これより古い画面からの書き込みは危険」という方針の値であり、
//   index.htmlのAPP_VERSIONのコピーではない。通常のデプロイでは上げない。古い画面のまま
//   書き込まれると壊れる変更(RLS有効化、APIの仕様変更等)をデプロイする時だけ、index.htmlの
//   APP_VERSIONを上げた上で、この値を同じ値まで上げる。
// - 「新しい版があります」の表示用に、各レスポンスへデプロイID(Vercelのシステム環境変数)を
//   X-App-Deploymentヘッダーとして付ける。画面側は最初に受け取った値と異なる値を受け取ったら
//   再読み込みを促す(自動リロードはしない)。環境変数が無い場合は空文字(画面側は判定しない)。

// この版より古い画面、およびヘッダーを送らない旧コード(main 4dfeb33以前・bbd5731)からの書き込みを拒否する。
// 2026092501: 画面の版による書き込みガードの導入(PR #212)。
// 2026092502: ホテル明細の区分(booking_hotels.lodging_for)の追加。古い画面はこの列を送らないため、ドライバー宿泊の行を
//             保存すると全削除→再挿入で既定値の「ゲスト」に戻ってしまう(2026-09-25)。
export const MIN_WRITE_APP_VERSION = 2026092502;

export const APP_VERSION_OUTDATED_CODE = 'APP_VERSION_OUTDATED';
export const APP_VERSION_OUTDATED_MESSAGE =
  '画面が古い版のため保存できません。Ctrl+Shift+R(MacはCmd+Shift+R)で再読み込みしてから、もう一度操作してください。'
  + '(再読み込みすると、保存していない入力内容は消えます。必要な内容は控えてから再読み込みしてください)';

// リクエストのX-App-Versionを整数で返す。無い・形式が不正ならnull。
export function getRequestAppVersion(req) {
  const h = req && req.headers ? req.headers['x-app-version'] : undefined;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string' || !/^\d{10}$/.test(v.trim())) return null;
  return Number(v.trim());
}

export function isAppVersionAllowedForWrite(version) {
  return typeof version === 'number' && version >= MIN_WRITE_APP_VERSION;
}

// デプロイごとに変わる識別子。Vercelの「System Environment Variables」(既定で有効)から取る。
export function getDeploymentId() {
  return process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_URL || '';
}

// 全レスポンスに付けるヘッダー(画面側の「新しい版があります」表示用)。
export function setAppVersionResponseHeaders(res) {
  res.setHeader('X-App-Deployment', getDeploymentId());
  res.setHeader('X-App-Min-Version', String(MIN_WRITE_APP_VERSION));
}
