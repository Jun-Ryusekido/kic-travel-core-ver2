// AI画像読み取り(OCR)機能で共通して使う、画像圧縮・アップロード前圧縮後サイズチェック。
// index.html(通帳/クレカ明細/請求書/ホテル/観光施設/バス/レストラン/ガイド登録等の
// AI読み取り)とguide.html(ガイド精算の領収書アップロード)の両方から
// <script src="/js/image-compress.js"></script>で読み込む共通実装。
//
// 経緯: 以前はindex.html側のcompressImageToBase64とguide.html側のcompressImageGuideが
// ほぼ同一ロジックのまま別々に実装されていた(重複)。index.htmlとguide.htmlは
// vercel.jsonでそれぞれ独立した静的ファイルとしてビルド・配信される構成のため、
// (バンドラでの共有importは使えない)、両ファイルから直接読み込める外部JSに
// 切り出して一本化した。
//
// 圧縮: 長辺maxDim(既定1800px)以下にリサイズし、JPEG品質0.85で再エンコードする
// (画質と送信サイズのバランスを取った既存の値をそのまま踏襲)。
// 圧縮後チェック: 通常のスマホ写真は圧縮後まずこの上限を超えないため、これは
// 異常系(極端に情報量の多い画像等)に備えた保険的なチェック。超えた場合は
// Errorをthrowするので、呼び出し側は既存のtry/catchでそのまま
// 「読み取り失敗: ...」等として表示すればよい。

function compressImageToBase64(file, maxDim){
  maxDim = maxDim || 1800;
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
      resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Base64文字列(データ部分のみ、"data:...;base64,"プレフィックス無し)から
// 元のバイナリの概算バイトサイズを計算する(パディング"="を考慮)。
function base64ByteSize(base64){
  if(!base64) return 0;
  const len = base64.length;
  const padding = base64.endsWith('==') ? 2 : (base64.endsWith('=') ? 1 : 0);
  return Math.floor(len * 3 / 4) - padding;
}

const OCR_COMPRESSED_MAX_MB = 3;
const OCR_COMPRESSED_MAX_BYTES = OCR_COMPRESSED_MAX_MB * 1024 * 1024;

// AI画像読み取り機能共通のエントリーポイント。圧縮後もなお大きすぎる場合は
// Errorをthrowする(通常の写真では起きない想定の異常系チェック)。
async function compressImageForOcr(file, maxDim){
  const base64 = await compressImageToBase64(file, maxDim);
  if(base64ByteSize(base64) > OCR_COMPRESSED_MAX_BYTES){
    throw new Error(`画像が大きすぎるため読み取れません(圧縮後も${OCR_COMPRESSED_MAX_MB}MBを超えています)。別の画像をお試しください。`);
  }
  return base64;
}
