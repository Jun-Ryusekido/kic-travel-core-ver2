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
// 経緯4(2026-09、EXIF Orientation対応): iPhone等で撮影した写真は、ピクセルデータ
// 自体は常に横向きで保存され、EXIFのOrientationタグ(1〜8)に実際の表示向きが
// 記録されていることがある。当初はCanvasへdrawImageする前に自前で回転・反転行列を
// 適用する実装を試みたが、実機検証の結果、モダンブラウザ(Chrome/Safari/Firefox
// いずれも2020年前後以降のバージョン)は<img>やcreateImageBitmapによる画像デコード
// 時点で、CSSのimage-orientation既定値(from-image)に従いEXIF Orientationタグを
// 自動的に反映した(正しい向きに回転済みの)ビットマップを返すことが判明した
// (width/height含め、8パターン全てで実測確認済み)。そのため自前で回転処理を
// 追加すると二重に回転がかかってしまうバグになる(createImageBitmapの
// {imageOrientation:'none'}オプションで自動回転を無効化しようとしても、
// 検証したブラウザでは効かず常に自動回転された)。よって、Canvas経由で処理する
// パス(loadImageToCanvas)では自動回転に任せ、自前の回転処理は行わない。
//
// ただし、ファイルサイズが十分小さく「圧縮せず元ファイルをそのまま送信する」
// スキップ経路(後述)は一切Canvasを経由しないため、この自動回転の恩恵を受けられない。
// 送信先(サーバー・AI)がEXIF Orientationを解釈する保証もないため、Orientationが
// 1(正立)以外の場合は、たとえファイルが小さくてもスキップ経路を使わずCanvas経由で
// 処理し(=ブラウザの自動回転で正しい向きに補正した上でJPEGとして再エンコードし、
// EXIFタグ自体を除去する)、向きの解釈を送信先に依存させないようにする。
//
// 現在の方針:
// 1. EXIF Orientationが1(正立)または読み取れない(EXIF無し・JPEG以外)場合で、かつ
//    元ファイルが十分小さい(IMAGE_SKIP_COMPRESS_MAX_BYTES以下)場合は、リサイズ・
//    再エンコードそのものをスキップし、元ファイルをそのままBase64化して送信する
//    (画質・解像度の劣化ゼロ)。
// 2. Orientationが2〜8(要回転・反転)の場合、またはファイルサイズが大きく圧縮が
//    必要な場合は、Canvasへ描画(ブラウザが自動的に正しい向きへ補正する)したうえで、
//    まずリサイズせずネイティブ解像度のまま、JPEG品質だけをIMAGE_COMPRESS_QUALITY_STEPS
//    の順(高品質→低品質)に段階的に下げて試す。いずれかの品質で目標サイズ
//    (OCR_COMPRESSED_MAX_BYTES)以下になれば、それ以上品質を下げずそのまま確定する
//    (解像度は常にネイティブのまま)。
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

// JPEGファイルのEXIF Orientationタグ(1〜8)を読み取る。EXIFはファイル先頭付近の
// APP1セグメントに入っているため、先頭128KBだけ読めば十分(画像本体全体は読まない)。
// JPEG以外・EXIF無し・タグ無し・解析失敗の場合はすべて1(正立、補正不要)を返す。
async function readExifOrientation(file){
  const looksJpeg = file.type === 'image/jpeg' || file.type === 'image/jpg' || /\.jpe?g$/i.test(file.name||'');
  if(!looksJpeg) return 1;
  try{
    const buffer = await file.slice(0, 128*1024).arrayBuffer();
    const view = new DataView(buffer);
    if(view.byteLength < 4 || view.getUint16(0, false) !== 0xFFD8) return 1; // SOIマーカーが無い=JPEGでない
    let offset = 2;
    while(offset + 4 <= view.byteLength){
      if(view.getUint8(offset) !== 0xFF) break;
      const marker = view.getUint8(offset+1);
      if(marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)){
        offset += 2; continue; // 長さフィールドを持たないマーカー
      }
      if(marker === 0xDA) break; // Start Of Scan(以降は画像データ本体、メタデータは無い)
      const segmentLength = view.getUint16(offset+2, false);
      if(marker === 0xE1 && offset + 4 + segmentLength <= view.byteLength){
        // APP1セグメント。"Exif\0\0"で始まるかを確認してからTIFFヘッダを解析する。
        if(view.getUint32(offset+4, false) === 0x45786966 && view.getUint16(offset+8, false) === 0x0000){
          const tiffStart = offset + 10;
          const little = view.getUint16(tiffStart, false) === 0x4949; // "II"=リトルエンディアン, "MM"=ビッグエンディアン
          const firstIfdOffset = view.getUint32(tiffStart+4, little);
          const dirStart = tiffStart + firstIfdOffset;
          if(dirStart + 2 <= view.byteLength){
            const entryCount = view.getUint16(dirStart, little);
            for(let i=0; i<entryCount; i++){
              const entryOffset = dirStart + 2 + i*12;
              if(entryOffset + 12 > view.byteLength) break;
              const tag = view.getUint16(entryOffset, little);
              if(tag === 0x0112){ // Orientationタグ
                const value = view.getUint16(entryOffset+8, little);
                return (value >= 1 && value <= 8) ? value : 1;
              }
            }
          }
        }
        return 1;
      }
      offset += 2 + segmentLength;
    }
  }catch(e){ /* 解析に失敗した場合は補正なし(1)として扱う */ }
  return 1;
}

// 画像をCanvasへ読み込む(リサイズなし)。上記コメントの通り、ブラウザが
// デコード時点でEXIF Orientationに応じた回転を自動的に適用するため、ここでは
// 単純にdrawImageするだけでよい(自前の回転処理は行わない)。
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
// 最初の{base64, quality}を返す。どの品質でも収まらない場合はnullを返す。
// quality込みで返すのは、rotateImageVariants側で同じ品質を4方向の再エンコードに
// 使い回し、方向ごとに探索をやり直す無駄を避けるため。
function findQualityAndBase64(canvas){
  for(const quality of IMAGE_COMPRESS_QUALITY_STEPS){
    const base64 = canvas.toDataURL('image/jpeg', quality).split(',')[1];
    if(base64ByteSize(base64) <= OCR_COMPRESSED_MAX_BYTES) return {base64, quality};
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
  const orientation = await readExifOrientation(file);

  // EXIF Orientationが正立(1、またはJPEG以外・EXIF無しで補正不要)の場合のみ、
  // 元ファイルサイズが十分小さければリサイズ・再エンコードそのものをスキップできる。
  // 2〜8(要回転・反転)の場合は、圧縮不要なサイズであってもCanvas経由での
  // 描画・再エンコードが必須になる(でなければ向きの情報が失われてしまうため)。
  if(orientation === 1 && file.size <= IMAGE_SKIP_COMPRESS_MAX_BYTES){
    const base64 = await readFileAsBase64Raw(file);
    return { base64, mediaType: file.type || 'image/jpeg' };
  }

  const nativeCanvas = await loadImageToCanvas(file);

  // 1. まずネイティブ解像度のまま、品質だけを段階的に下げて試す。
  let result = findQualityAndBase64(nativeCanvas);
  if(result !== null) return { base64: result.base64, mediaType: 'image/jpeg' };

  // 2. 最低品質でもネイティブ解像度では収まらない場合のみ、最後の手段として
  //    リサイズしてから同じ品質段階を再度試す。
  const resizedCanvas = resizeCanvasToMaxDim(nativeCanvas, maxDim);
  result = findQualityAndBase64(resizedCanvas);
  if(result !== null) return { base64: result.base64, mediaType: 'image/jpeg' };

  throw new Error(`画像が大きすぎるため読み取れません(圧縮後も${OCR_COMPRESSED_MAX_MB}MBを超えています)。別の画像をお試しください。`);
}

// 圧縮済みの画像(compressImageForOcrの戻り値のbase64/mediaType)を0/90/180/270度
// 回転させた4パターンのBase64配列を返す。サーバー側でどの向きが正立かをAIに判定させ
// (安価な「正立ですか?」だけの呼び出しを4パターン分並列実行)、正しい向きの1枚だけを
// 本読み取りに使う仕組み(取引先名刺OCR・クレジットカード明細OCRで使用)のために存在する。
// 0度は再エンコードせず元のbase64をそのまま返す(無駄な劣化を避けるため)。
function rotateImageVariants(base64, mediaType){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // 90/180/270度の再エンコードで使う品質を1回だけ探索する(以前は固定品質0.85で
      // 再エンコードしていたため、compressImageForOcr側でどれだけ高画質を維持していても
      // ここで台無しになる二重圧縮になっていた不具合の修正)。0度と180度・90度と270度は
      // 総ピクセル数が同じ(縦横が入れ替わるだけ)なので、0度相当のCanvasで1回だけ
      // 品質を探索し、その結果を4方向すべての再エンコードに使い回す
      // (方向ごとに個別探索する無駄な繰り返しを避けるため)。
      const probeCanvas = document.createElement('canvas');
      probeCanvas.width = img.width; probeCanvas.height = img.height;
      probeCanvas.getContext('2d').drawImage(img, 0, 0);
      let quality = IMAGE_COMPRESS_QUALITY_STEPS[IMAGE_COMPRESS_QUALITY_STEPS.length - 1];
      for(const q of IMAGE_COMPRESS_QUALITY_STEPS){
        const probeBase64 = probeCanvas.toDataURL(mediaType, q).split(',')[1];
        if(base64ByteSize(probeBase64) <= OCR_COMPRESSED_MAX_BYTES){ quality = q; break; }
      }

      const rotate = (deg) => {
        if(deg === 0) return base64;
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if(deg === 90 || deg === 270){ canvas.width = img.height; canvas.height = img.width; }
        else { canvas.width = img.width; canvas.height = img.height; }
        ctx.translate(canvas.width/2, canvas.height/2);
        ctx.rotate(deg*Math.PI/180);
        ctx.drawImage(img, -img.width/2, -img.height/2);
        return canvas.toDataURL(mediaType, quality).split(',')[1];
      };
      resolve([0,90,180,270].map(rotate));
    };
    img.onerror = reject;
    img.src = 'data:'+mediaType+';base64,'+base64;
  });
}
