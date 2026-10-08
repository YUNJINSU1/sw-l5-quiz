// 채점·모의고사 로직. 브라우저(window.QuizLogic)와 node(require) 양쪽에서 쓴다.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.QuizLogic = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TYPES = ["choice", "multi", "match", "short", "blanks", "list", "self"];
  const LEFT_LABELS = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차"];
  const RIGHT_LABELS = "abcdefghijklmnopqrstuvwxyz".split("");

  function questionType(q) {
    return q.type || "choice";
  }

  function isAuto(q) {
    return questionType(q) !== "self";
  }

  // NFKC → 소문자 → 공백·하이픈·가운뎃점 제거. 부분 일치는 쓰지 않는다.
  function normalize(s) {
    return String(s ?? "").normalize("NFKC").toLowerCase().replace(/[\s\-‐–·ㆍ]+/g, "");
  }

  // "가(나)"는 전체·가·나를 모두 인정한다. 괄호 앞에 글자가 있고 괄호가 끝에 있을 때만 쪼갠다.
  function variants(accept) {
    const out = new Set();
    for (const raw of accept) {
      out.add(normalize(raw));
      const m = /^(.+?)\s*\((.+)\)\s*$/.exec(raw);
      if (m) { out.add(normalize(m[1])); out.add(normalize(m[2])); }
    }
    out.delete("");
    return out;
  }

  function matches(input, accept) {
    const v = normalize(input);
    return v !== "" && variants(accept).has(v);
  }

  // 입력 i가 pool 항목 j와 맞는지의 이분 그래프에서 최대 매칭(Kuhn). 항목 수가 작아 충분하다.
  function matchList(inputs, pool) {
    const owner = new Array(pool.length).fill(-1);
    const hits = inputs.map(x => pool.map(acc => matches(x, acc)));
    const tryAssign = (i, seen) => {
      for (let j = 0; j < pool.length; j++) {
        if (!hits[i][j] || seen[j]) continue;
        seen[j] = true;
        if (owner[j] < 0 || tryAssign(owner[j], seen)) { owner[j] = i; return true; }
      }
      return false;
    };
    inputs.forEach((_, i) => tryAssign(i, []));
    const parts = inputs.map((_, i) => owner.includes(i));
    return parts;
  }

  // response 형태: choice=인덱스, multi=인덱스 배열, match=right 인덱스 배열,
  // short=문자열, blanks/list=문자열 배열. 반환: {ok, parts?}
  function grade(q, response) {
    switch (questionType(q)) {
      case "choice":
        return { ok: response === q.a };
      case "multi": {
        const picked = [...new Set(response || [])].sort((x, y) => x - y);
        const want = [...q.a].sort((x, y) => x - y);
        return { ok: picked.length === want.length && picked.every((v, i) => v === want[i]) };
      }
      case "match": {
        const parts = q.a.map((v, i) => (response || [])[i] === v);
        return { ok: parts.every(Boolean), parts };
      }
      case "short":
        return { ok: matches(response, q.accept) };
      case "blanks": {
        const parts = q.blanks.map((b, i) => matches((response || [])[i], b.accept));
        return { ok: parts.every(Boolean), parts };
      }
      case "list": {
        const inputs = Array.from({ length: q.n }, (_, i) => (response || [])[i] ?? "");
        const parts = matchList(inputs, q.pool);
        return { ok: parts.every(Boolean), parts };
      }
      default:
        throw new Error(`자동채점할 수 없는 유형: ${questionType(q)}`);
    }
  }

  function answerText(q) {
    switch (questionType(q)) {
      case "choice": return q.c[q.a];
      case "multi": return [...q.a].sort((x, y) => x - y).map(i => q.c[i]).join(", ");
      case "match": return q.a.map((r, i) => `${q.left[i]} → ${q.right[r]}`).join(" / ");
      case "short": return q.accept[0];
      case "blanks": return q.blanks.map(b => `${b.label} ${b.accept[0]}`).join("  ");
      case "list": {
        const items = q.pool.map(p => p[0]).join(", ");
        return q.pool.length > q.n ? `다음 중 ${q.n}가지: ${items}` : items;
      }
      default: return q.answer;
    }
  }

  // 수험자가 쓴 답을 결과 화면에 보여줄 문자열로
  function responseText(q, r) {
    const blank = "(미응답)";
    switch (questionType(q)) {
      case "choice": return Number.isInteger(r) ? q.c[r] : blank;
      case "multi": return r?.length ? [...r].sort((x, y) => x - y).map(i => q.c[i]).join(", ") : blank;
      case "match": return r?.some(Number.isInteger)
        ? q.left.map((l, i) => `${l} → ${Number.isInteger(r[i]) ? q.right[r[i]] : "?"}`).join(" / ") : blank;
      case "short": return r?.trim() ? r.trim() : blank;
      case "blanks": return r?.some(s => s?.trim())
        ? q.blanks.map((b, i) => `${b.label} ${r[i]?.trim() || "?"}`).join("  ") : blank;
      case "list": return r?.some(s => s?.trim()) ? r.map(s => s?.trim() || "?").join(", ") : blank;
      default: return blank;
    }
  }

  // 문항 id = 문제 텍스트의 djb2 해시. 배열 순서와 무관하므로 팩 중간에 문항을 끼워 넣어도
  // 저장된 오답 기록이 어긋나지 않는다. 문제 텍스트를 고치면 새 문항으로 취급된다.
  function qid(text) {
    let h = 5381;
    for (const ch of text) h = (h * 33 ^ ch.codePointAt(0)) >>> 0;
    return h.toString(36);
  }

  function shuffle(arr, rng = Math.random) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 능력단위 순서대로, 단위마다 자동채점 문항을 perUnit개까지 무작위로 뽑는다.
  function buildExam(questions, exam, rng = Math.random) {
    return exam.units.flatMap(unit =>
      shuffle(questions.filter(q => q.cat === unit && isAuto(q)), rng).slice(0, exam.perUnit));
  }

  // results[i]는 paper[i]의 정답 여부. 문항이 없는 단위는 결과에서 뺀다.
  function scoreExam(paper, results, exam) {
    return exam.units.map(unit => {
      const idx = paper.map((q, i) => (q.cat === unit ? i : -1)).filter(i => i >= 0);
      const correct = idx.filter(i => results[i]).length;
      const total = idx.length;
      const score = total ? Math.round(correct / total * 100) : 0;
      return { unit, correct, total, score, pass: score >= exam.pass };
    }).filter(r => r.total > 0);
  }

  return {
    TYPES, LEFT_LABELS, RIGHT_LABELS,
    questionType, isAuto, normalize, variants, matches, grade, answerText, responseText,
    shuffle, buildExam, scoreExam, qid,
  };
});
