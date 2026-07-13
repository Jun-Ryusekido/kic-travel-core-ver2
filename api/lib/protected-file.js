// パスワード保護されたPDF/Excelファイルの検知・復号を行う共通ヘルパー。
//
// PDF: mupdf（Artifex製の公式npmパッケージ。WASMベースの純粋なJS実装で、
//      qpdf等の外部バイナリを別途インストールする必要がない。Vercelのサーバーレス
//      関数環境でもそのまま動作する）を使用。
// Excel: officecrypto-tool（純粋なJS実装。xlsx/xlsのMS-OFFCRYPTO暗号化に対応）を使用。
//
// いずれも「パスワードで復号したファイルは一時的にメモリ上で処理し、処理後に残さない」
// 方針に沿って、ディスクや/tmpには一切書き出さず、すべてメモリ上のBufferで完結させている。
//
// パスワードそのものは絶対にログ出力しないこと（呼び出し側も含め、catchしたエラーの
// メッセージにパスワードの値を含めないよう注意する）。

import * as mupdf from 'mupdf';
import officeCrypto from 'officecrypto-tool';
import XLSX from 'xlsx';

// エラーに立てるマーカー。呼び出し側はこれを見て password_required / invalid_password を判定する。
export class PasswordRequiredError extends Error {
  constructor() { super('password_required'); this.code = 'password_required'; }
}
export class InvalidPasswordError extends Error {
  constructor() { super('invalid_password'); this.code = 'invalid_password'; }
}

export function isPdfEncrypted(pdfBuffer) {
  try {
    const doc = mupdf.Document.openDocument(pdfBuffer, 'application/pdf');
    return doc.needsPassword();
  } catch (e) {
    // 破損ファイル等、mupdfが開けない場合はここでは判定しない（後続のPDF処理側の
    // 通常のエラーハンドリングに委ねる）
    return false;
  }
}

// パスワードで復号し、暗号化を解除したPDFのBase64文字列を返す。
// password未指定・不一致の場合はそれぞれ PasswordRequiredError / InvalidPasswordError を投げる。
export function decryptPdfToBase64(pdfBuffer, password) {
  const doc = mupdf.PDFDocument.openDocument(pdfBuffer, 'application/pdf');
  if (doc.needsPassword()) {
    if (!password) throw new PasswordRequiredError();
    const authResult = doc.authenticatePassword(password);
    if (!authResult) throw new InvalidPasswordError();
  }
  // 'encrypt=none' を明示しないと、saveToBufferは既存の暗号化設定を保持したまま書き出してしまう
  // （実測で確認済み。'decrypt=yes'は動作するが非推奨警告が出るため'encrypt=none'を使用）
  const decryptedBuffer = doc.saveToBuffer('encrypt=none');
  return Buffer.from(decryptedBuffer.asUint8Array()).toString('base64');
}

export function isExcelEncrypted(excelBuffer) {
  try {
    return officeCrypto.isEncrypted(excelBuffer);
  } catch (e) {
    return false;
  }
}

// パスワードで復号し、各シートをCSVテキスト化して結合した文字列を返す
// （既存の hotelText / busText 等のテキストベースのAI読み取りプロンプトにそのまま渡せる形式）。
export async function decryptExcelToSheetsText(excelBuffer, password) {
  if (!password) throw new PasswordRequiredError();
  let decryptedBuffer;
  try {
    decryptedBuffer = await officeCrypto.decrypt(excelBuffer, { password });
  } catch (e) {
    throw new InvalidPasswordError();
  }
  const workbook = XLSX.read(decryptedBuffer, { type: 'buffer' });
  return workbook.SheetNames
    .map((name) => `[シート: ${name}]\n${XLSX.utils.sheet_to_csv(workbook.Sheets[name])}`)
    .join('\n\n');
}
