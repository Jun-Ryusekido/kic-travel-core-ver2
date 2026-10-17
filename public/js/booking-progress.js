// 予約の進捗判定(見積 → 手配 → 書類 → 請求 → 入金)の共通ロジック。純粋関数のみ(DB・DOM非依存)。
//
// 読み込み元:
//   - ブラウザ(予約詳細の進捗ステッパー・予約一覧の進捗ドット): <script src="/js/booking-progress.js">
//     → window.BookingProgress
//   - Node(scripts/progress_dryrun.js): require('../public/js/booking-progress.js')
// 詳細画面と一覧画面と検証スクリプトが「同じファイルの同じ関数」を使うことで、判定のずれを防ぐ。
// 進捗状態そのものはどこにも保存しない(表示のたびに既存データから計算する)。
//
// judgeBookingProgress(input) の入力:
//   booking:        { status }                      bookings.status。'cancelled' なら全段階「対象外」
//   hasEstimation:  boolean                         estimations.converted_booking_id が当該予約を指す見積が1件以上
//   hotels:         [{ status }]                    booking_hotels の行
//   buses:          [{ status }]                    booking_buses の行
//   activeInvoiceCount: number                      invoices のうち status が 'void' 以外の件数
//   salesTotal:     number                          booking_sales.amount の予約単位合計
//   paidTotal:      number                          booking_sales.payments[].amount の予約単位合計
//   salesRowCount:  number(任意)                    booking_sales の行数。0 のとき入金は「未着手(売上未入力)」
//   hideAmounts:    boolean(任意)                   true のとき、画面用の文言から金額を伏せる(財務サマリーを
//                                                   閲覧できないロール向け。状態の判定自体は変えない)
// 返り値: { cancelled, stages:{estimate,arrangement,document,invoice,payment}, needsAttention, reasons }
//   stages.X = { state, text, reasons:[{code,text,badge,message}] }  text=丸の下の短い説明 / badge=一覧の短いバッジ / message=詳細の理由の帯
//   reasons(全体) = [{stage,code,text,badge,message}]
//   state: 'done'(完了) | 'progress'(進行中) | 'todo'(未着手) | 'alert'(要確認) | 'na'(対象外)
(function(root){
  'use strict';

  var STAGE_KEYS = ['estimate', 'arrangement', 'document', 'invoice', 'payment'];
  var STAGE_LABELS = { estimate: '見積', arrangement: '手配', document: '書類', invoice: '請求', payment: '入金' };
  var STATE_LABELS = { done: '完了', progress: '進行中', todo: '未着手', alert: '要確認', na: '対象外' };

  // 入金と売上を「等しい」とみなす許容差(1円未満)。売上に ¥8,256,458.5 のような小数があるため。
  var YEN_TOLERANCE = 1;

  // 手配ステータスの正規化。旧値「確定」は手配OK、「回答待ち」は問い合わせ中として扱う。
  // 空/未設定は未予約。これ以外の未知の値は null を返し、呼び出し側で「未知」として別集計する。
  var ARR_KNOWN = { '未予約': 1, '問い合わせ中': 1, '手配OK': 1, 'FNL済': 1, 'NG回答': 1, 'キャンセル': 1, '予約不要': 1 };
  function normalizeArrangementStatus(raw){
    var s = String(raw == null ? '' : raw).trim();
    if(s === '') return '未予約';
    if(s === '確定') return '手配OK';
    if(s === '回答待ち') return '問い合わせ中';
    return ARR_KNOWN[s] ? s : null;
  }

  function stage(state, text, reasons){
    return { state: state, text: text, reasons: reasons || [] };
  }

  function fmtYen(n){
    return Math.round(n).toLocaleString('en-US');
  }

  function judgeArrangement(hotels, buses){
    var rows = [].concat(hotels || [], buses || []);
    var cnt = { total: 0, ok: 0, inquiry: 0, todo: 0, ng: 0, cancel: 0, unknown: 0 };
    rows.forEach(function(r){
      var s = normalizeArrangementStatus(r && r.status);
      if(s === '予約不要') return; // 集計から除外
      cnt.total++;
      if(s === '手配OK' || s === 'FNL済') cnt.ok++;
      else if(s === '問い合わせ中') cnt.inquiry++;
      else if(s === 'NG回答') cnt.ng++;
      else if(s === 'キャンセル') cnt.cancel++;
      else if(s === '未予約') cnt.todo++;
      else cnt.unknown++; // 未知の値は未予約と同様に「完了していない」扱い
    });
    var detail = { counts: cnt };
    var out;
    if(cnt.ng > 0 || cnt.cancel > 0){
      var reasons = [];
      if(cnt.ng > 0) reasons.push({ code: 'arr_ng', text: 'NG回答 ' + cnt.ng + '件', badge: '手配NG回答', message: '手配にNG回答が ' + cnt.ng + '件あります' });
      if(cnt.cancel > 0) reasons.push({ code: 'arr_cancel', text: 'キャンセル ' + cnt.cancel + '件', badge: '手配キャンセル', message: '手配にキャンセルが ' + cnt.cancel + '件あります' });
      out = stage('alert', reasons.map(function(r){ return r.text; }).join(' / '), reasons);
    }else if(cnt.inquiry > 0){
      out = stage('progress', '問い合わせ中 ' + cnt.inquiry + '件');
    }else if(cnt.total > 0 && cnt.ok === cnt.total){
      out = stage('done', cnt.ok + '/' + cnt.total + '件 OK');
    }else if(cnt.total === 0 || cnt.ok === 0){
      // 行0件、または手配OK/FNL済が1件もない(全件未予約など)
      out = stage('todo', cnt.total === 0 ? '手配なし' : '未予約 ' + (cnt.todo + cnt.unknown) + '件');
    }else{
      // 一部だけ手配OK/FNL済で、問い合わせ中も NG/キャンセルも無い(残りは未予約) → 進行中
      out = stage('progress', cnt.ok + '/' + cnt.total + '件 OK');
    }
    out.detail = detail;
    return out;
  }

  function judgePayment(salesTotal, paidTotal, opts){
    opts = opts || {};
    var hide = !!opts.hideAmounts;
    var S = Number(salesTotal) || 0;
    var P = Number(paidTotal) || 0;
    var diff = P - S;
    var paidLabel = hide ? null : fmtYen(P) + ' / ' + fmtYen(S) + '円';
    if(opts.salesRowCount === 0){
      return stage('todo', '売上未入力'); // 売上明細が1行も無い予約は要確認にしない
    }
    if(S <= -YEN_TOLERANCE){
      return stage('alert', hide ? '要確認' : '売上がマイナス', [{ code: 'sales_negative', text: '売上がマイナス', badge: '売上マイナス', message: '売上合計がマイナスです' + (hide ? '' : '(' + fmtYen(S) + '円)') }]);
    }
    if(S < YEN_TOLERANCE){ // 売上0円(1円未満)
      if(P >= YEN_TOLERANCE){
        return stage('alert', hide ? '要確認' : '売上0円で入金あり',
          [{ code: 'sales_zero_with_payment', text: '売上が0円(入金あり)', badge: '売上0円で入金あり',
             message: hide ? '売上合計が0円ですが、入金があります' : '売上合計が0円ですが、入金が ' + fmtYen(P) + '円あります' }]);
      }
      return stage('todo', '売上・入金なし');
    }
    if(Math.abs(diff) < YEN_TOLERANCE) return stage('done', hide ? '入金済' : paidLabel);
    if(diff >= YEN_TOLERANCE){
      return stage('alert', hide ? '要確認' : '超過 ' + fmtYen(diff) + '円',
        [{ code: 'overpaid', text: '入金が売上を超過', badge: '入金超過',
           message: hide ? '入金が売上合計を超えています' : '入金 ' + fmtYen(P) + '円が売上合計 ' + fmtYen(S) + '円を超えています' }]);
    }
    if(P < YEN_TOLERANCE) return stage('todo', hide ? '入金なし' : paidLabel);
    return stage('progress', hide ? '一部入金' : paidLabel);
  }

  function judgeBookingProgress(input){
    input = input || {};
    var booking = input.booking || {};
    if(booking.status === 'cancelled'){
      var na = function(){ return stage('na', '—'); };
      return {
        cancelled: true,
        stages: { estimate: na(), arrangement: na(), document: na(), invoice: na(), payment: na() },
        needsAttention: false,
        reasons: [],
      };
    }
    var stages = {
      estimate: input.hasEstimation ? stage('done', '見積あり') : stage('na', '見積なし'),
      arrangement: judgeArrangement(input.hotels, input.buses),
      // 手配一覧表の作成記録を示す信頼できる列が無いため、現状は判定しない(中立表示)。
      document: stage('na', '記録なし'),
      invoice: (Number(input.activeInvoiceCount) || 0) > 0
        ? stage('done', '請求書 ' + Number(input.activeInvoiceCount) + '件')
        : stage('todo', '未発行'),
      payment: judgePayment(input.salesTotal, input.paidTotal, { salesRowCount: input.salesRowCount, hideAmounts: input.hideAmounts }),
    };
    var reasons = [];
    STAGE_KEYS.forEach(function(k){
      stages[k].reasons.forEach(function(r){ reasons.push({ stage: k, code: r.code, text: r.text, badge: r.badge, message: r.message }); });
    });
    return { cancelled: false, stages: stages, needsAttention: reasons.length > 0, reasons: reasons };
  }

  var api = {
    STAGE_KEYS: STAGE_KEYS,
    STAGE_LABELS: STAGE_LABELS,
    STATE_LABELS: STATE_LABELS,
    YEN_TOLERANCE: YEN_TOLERANCE,
    normalizeArrangementStatus: normalizeArrangementStatus,
    judgeArrangement: judgeArrangement,
    judgePayment: judgePayment,
    judgeBookingProgress: judgeBookingProgress,
  };
  root.BookingProgress = api;
  if(typeof module !== 'undefined' && module.exports){
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : globalThis);
