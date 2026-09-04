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
// 経緯2(2026-09、長辺2400px固定リサイズ版): 一本化した時点では、画像は常に長辺1800px・
// JPEG品質0.85まで縮小・再エンコードしていた。これがクレジットカード明細のような
// 小さい文字がびっしり並ぶ書類で読み取り精度を大きく劣化させる不具合(店名の誤読等)を
// 引き起こしたため、長辺2400px・品質0.92開始に緩和した。
//
// 経緯3(2026-09、解像度優先方式への変更): 上記の緩和後も、ネイティブ解像度が2400pxを
// 超えるスマホ写真(2.5MB超のファイルは大半がこれに該当)では、依然として強制的に
// 2400pxへ縮小されてから再エンコードされていた。これにより「店舗名が完全に空欄になる」
// 不具合が発生(サーバー側プロンプトが「店舗名が読み取れない場合はnullにする」と
// AIに指示しているため、解像度不足で読めなくなると誤読ではなく空欄として返ってくる)。
// 文字認識では色の階調(JPEG品質)よりピクセル密度(解像度)の方が重要なため、
// 劣化させる順序を「解像度を先に落とす」から「品質を先に落とす」へ逆転させた。
//
// 現在の方針:
// 1. 元ファイルが十分小さい(IMAGE_SKIP_COMPRESS_MAX_BYTES以下)場合は、リサイズ・
//    再エンコードそのものをスキップし、元ファイルをそのままBase64化して送信する
//    (画質・解像度の劣化ゼロ)。
// 2. 圧縮が必要な場合、まずリサイズせずネイティブ解像度のまま、JPEG品質だけを
//    IMAGE_COMPRESS_QUALITY_STEPSの順(高品質→低品質)に段階的に下げて試す。
//    いずれかの品質で目標サイズ(OCR_COMPRESSED_MAX_BYTES)以下になれば、
//    それ以上品質を下げずそのまま確定する(解像度は常にネイティブのまま)。
// 3. 最低品質まで下げても目標サイズに収まらない場合(極端に高解像度な画像等)のみ、
//    最後の手段として長辺IMAGE_COMPRESS_MAX_DIM以下へリサイズし、そのリサイズ後の
//    画像に対して再度2と同じ品質段階を試す。

const IMAGE_SKIP_COMPRESS_MAX_MB = 2.5;
const IMAGE_SKIP_COMPRESS_MAX_BYTES = IMAGE_SKIP_COMPRESS_MAX_MB * 1024 * 1024;
// リサイズが必要になった場合(最後の手段)にのみ使う長辺の上限。
const IMAGE_COMPRESS_MAX_DIM = 2400;
// 圧縮が必要な場合に試す品質を、劣化が小さい順(高品質→低品質)に並べたもの。
// 各段階でBase64サイズを確認し、目標(OCR_COMPRESSED_MAX_BYTES)以下になった時点で
// それ以上下げずに確定する。
const IMAGE_COMPRESS_QUALITY_STEPS = [0.92, 0.85, 0.75, 0.65, 0.5];
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

// 画像をCanvasへ読み込む(リサイズなし、ネイティブ解像度のまま)。
// リサイズが必要かどうかは呼び出し側(compressImageForOcr)が判断する。
function loadImageToCanvas(file){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = () => { img.src = reader.result; };
    reader.onerror = reject;
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 既存のCanvas(srcCanvas)を、長辺maxDim以下になるよう等比縮小した新しいCanvasを返す
// (縮小のみ、拡大はしない)。ファイルの再読み込みは行わず、既にデコード済みの
// srcCanvasから直接描画するため軽量。
function resizeCanvasToMaxDim(srcCanvas, maxDim){
  let w = srcCanvas.width, h = srcCanvas.height;
  if(w > maxDim || h > maxDim){
    if(w > h){ h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(srcCanvas, 0, 0, w, h);
  return canvas;
}

// Base64文字列(データ部分のみ、"data:...;base64,"プレフィックス無し)から
// 元のバイナリの概算バイトサイズを計算する(パディング"="を考慮)。
function base64ByteSize(base64){
  if(!base64) return 0;
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.floor(len * 3 / 4) - padding;
}

// canvasに対してIMAGE_COMPRESS_QUALITY_STEPSを順に試し、目標サイズ以下になった
// 最初のBase64を返す。どの品質でも収まらない場合はnullを返す。
function tryQualitySteps(canvas){
  let base64 = null;
  for(const quality of IMAGE_COMPRESS_QUALITY_STEPS){
    base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if(base64ByteSize(base64) <= OCR_COMPRESSED_MAX_BYTES) return base64;
  }
  return null;
}

// AI画像読み取り機能共通のエントリーポイント。
// 戻り値: { base64, mediaType }
//   - 元ファイルが十分小さい場合: 圧縮せず、元ファイルそのままのBase64・実際のMIMEタイプ
//   - 圧縮が必要な場合: 解像度優先(ネイティブ解像度のまま品質のみ調整)で目標サイズに
//     収まった時点のJPEGのBase64・'image/jpeg'。それでも収まらない場合のみ最後の手段
//     として長辺maxDim以下へリサイズしてから同様に品質調整する。
// リサイズしてもなお目標サイズを超える場合(通常の写真ではまず起きない異常系)はErrorを
// throwする。呼び出し側は既存のtry/catchでそのまま「読み取り失敗: ...」等として
// 表示すればよい。
async function compressImageForOcr(file, maxDim){
  maxDim = maxDim || IMAGE_COMPRESS_MAX_DIM;

  if(file.size <= IMAGE_SKIP_COMPRESS_MAX_BYTES){
    const base64 = await readFileAsBase64Raw(file);
    return { base64, mediaType: file.type || 'image/jpeg' };
  }

  const nativeCanvas = await loadImageToCanvas(file);

  // 1. まずネイティブ解像度のまま、品質だけを段階的に下げて試す。
  let base64 = tryQualitySteps(nativeCanvas);
  if(base64 !== null) return { base64, mediaType: 'image/jpeg' };

  // 2. 最低品質でもネイティブ解像度では収まらない場合のみ、最後の手段として
  //    リサイズしてから同じ品質段階を再度試す。
  const resizedCanvas = resizeCanvasToMaxDim(nativeCanvas, maxDim);
  base64 = tryQualitySteps(resizedCanvas);
  if(base64 !== null) return { base64, mediaType: 'image/jpeg' };

  throw new Error(`画像が大きすぎるため読み取れません(圧縮後も${OCR_COMPRESSED_MAX_MB}MBを超えています)。別の画像をお試しください。`);
}
