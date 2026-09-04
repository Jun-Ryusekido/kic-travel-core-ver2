// AI画像読み取り(OCR)機能で共通して使う、画像圧縮・アップロード前圧縮後サイズチェック。
// index.html(通帳/クレジット明細/請求書/ホテル/観光施設/バス/レストラン/ガイド登録等の
// AI読み取り)とguide.html(ガイド精算の領収書アップロード)の両方から
// <script src="/js/image-compress.js"></script>で読み込む共通実装。
//
// 経緯1: 以前はindex.html側のcompressImageToBase64とguide.html側のcompressImageGuideが
// ほぼ同一ロジックのまま別々に実装されていた(重複)。index.htmlとguide.htmlは
// vercel.jsonでそれぞれ独立した静的ファイルとしてビルド・配信される構成のため
// (バンドラでの共有importは使えない)、両ファイルから直接読み込める外部JSに
// 切り出して一本化した。
//
// 経緯2(2026-09): 上記の一本化時点では、画像は常に長辺1800px・JPEG品質0.85まで
// リサイズ・再エンコードしていた。これがクレジットカード明細のような小さい文字が
// びっしり並ぶ書類で読み取り精度を大きく劣化させる不具合(店名の誤読等)を
// 引き起こしたため、以下の方針に変更した。
// 1. 元ファイルが十分小さい(IMAGE_SKIP_COMPRESS_MAX_BYTES以下)場合は、リサイズ・
//    再エンコードそのものをスキップし、元ファイルをそのままBase64化して送信する
//    (画質劣化ゼロ)。
// 2. 圧縮が必要な場合も、長辺の上限を2400pxに引き上げ、JPEG品質はまず0.92を試し、
//    圧縮後サイズがOCR_COMPRESSED_MAX_BYTESを超える場合のみ品質を段階的に
//    (IMAGE_COMPRESS_QUALITY_STEPSの順に)下げていく。一発の固定値まで落とすのではなく
//    必要な分だけ下げることで、無駄な画質劣化を避ける。

const IMAGE_SKIP_COMPRESS_MAX_MB = 2.5;
const IMAGE_SKIP_COMPRESS_MAX_BYTES = IMAGE_SKIP_COMPRESS_MAX_MB * 1024 * 1024;
const IMAGE_COMPRESS_MAX_DIM = 2400;
// 圧縮が必要な場合に試す品質を、劣化が小さい順(高品質→低品質)に並べたもの。
// 各段階でBase64サイズを確認し、目標(OCR_COMPRESSED_MAX_BYTES)以下になった時点で
// それ以上下げずに確定する。
const IMAGE_COMPRESS_QUALITY_STEPS = [0.92, 0.85, 0.75];
const OCR_COMPRESSED_MAX_MB = 3;
const OCR_COMPRESSED_MAX_BYTES = OCR_COMPRESSED_MAX_MB * 1024 * 1024;

function readFileAsBase64Raw(file){
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 画像をCanvasへ読み込み、長辺maxDim以下に等比縮小する(縮小のみ、拡大はしない)。
// リサイズ処理自体は重いため、品質を変えて何度もtoDataURLを呼ぶ場合でも
// この処理は1回で済むようにCanvasを返す(呼び出し側で使い回す)。
function loadImageResizedToCanvas(file, maxDim){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      let w = img.width, h = img.height;
      if(w > maxDim || h > maxDim){
        if(w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
        else { w = Math.round(w * maxDim / h); h = maxDim; }
      }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 単発で「長辺maxDim以下・JPEG品質quality」に圧縮したBase64が欲しい場合の関数
// (このファイル内のcompressImageForOcrから使われる想定。呼び出し元コードからは
// 直接使わず、常にcompressImageForOcrを使うこと)。
async function compressImageToBase64(file, maxDim, quality){
  const canvas = await loadImageResizedToCanvas(file, maxDim || IMAGE_COMPRESS_MAX_DIM);
  return canvas.toDataURL('image/jpeg', quality || IMAGE_COMPRESS_QUALITY_STEPS[0]).split(',')[1];
}

// Base64文字列(データ部分のみ、"data:...;base64,"プレフィックス無し)から
// 元のバイナリの概算バイトサイズを計算する(パディング"="を考慮)。
function base64ByteSize(base64){
  if(!base64) return 0;
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.floor(len * 3 / 4) - padding;
}

// AI画像読み取り機能共通のエントリーポイント。
// 戻り値: { base64, mediaType }
//   - 元ファイルが十分小さい場合: 圧縮せず、元ファイルそのままのBase64・実際のMIMEタイプ
//   - 圧縮が必要な場合: 長辺maxDim以下・品質は必要な分だけ下げたJPEGのBase64・'image/jpeg'
// 圧縮してもなお目標サイズを超える場合(通常の写真ではまず起きない異常系)はErrorを
// throwする。呼び出し側は既存のtry/catchでそのまま「読み取り失敗: ...」等として
// 表示すればよい。
async function compressImageForOcr(file, maxDim){
  maxDim = maxDim || IMAGE_COMPRESS_MAX_DIM;

  if(file.size <= IMAGE_SKIP_COMPRESS_MAX_BYTES){
    const base64 = await readFileAsBase64Raw(file);
    return { base64, mediaType: file.type || 'image/jpeg' };
  }

  const canvas = await loadImageResizedToCanvas(file, maxDim);
  let base64 = null;
  for(const quality of IMAGE_COMPRESS_QUALITY_STEPS){
    base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if(base64ByteSize(base64) <= OCR_COMPRESSED_MAX_BYTES) break;
  }
  if(base64ByteSize(base64) > OCR_COMPRESSED_MAX_BYTES){
    throw new Error(`画像が大きすぎるため読み取れません(圧縮後も${OCR_COMPRESSED_MAX_MB}MBを超えています)。別の画像をお試しください。`);
  }
  return { base64, mediaType: 'image/jpeg' };
}
