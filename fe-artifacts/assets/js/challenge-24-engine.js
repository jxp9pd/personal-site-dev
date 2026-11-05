const MAX_EXPRESSION_LENGTH = 160;
const MAX_DEPTH = 16;

function validNumbers(numbers) {
  return Array.isArray(numbers) && numbers.length === 4 &&
    Array.from(numbers).every(number => Number.isInteger(number) && number >= 1 && number <= 9);
}

function rational(numerator, denominator = 1) {
  if (denominator === 0) throw new Error('Division by zero is not allowed.');
  if (denominator < 0) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let a = Math.abs(numerator);
  let b = denominator;
  while (b) [a, b] = [b, a % b];
  return { numerator: numerator / a, denominator: denominator / a };
}

function calculate(left, right, operator) {
  const { numerator: a, denominator: b } = left;
  const { numerator: c, denominator: d } = right;
  switch (operator) {
    case '+': return rational(a * d + c * b, b * d);
    case '-': return rational(a * d - c * b, b * d);
    case '*': return rational(a * c, b * d);
    case '/': return rational(a * d, b * c);
  }
}

function tokenize(source) {
  const tokens = [];
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (/\s/.test(character)) continue;
    if (/[0-9]/.test(character)) {
      if (character === '0' || /[0-9]/.test(source[index + 1] ?? '')) {
        throw new Error('Use each given number separately; no concatenation.');
      }
      tokens.push(Number(character));
    } else if ('+-*/()'.includes(character)) {
      tokens.push(character);
    } else {
      throw new Error('Use only numbers, +, −, ×, ÷ and parentheses.');
    }
  }
  return tokens;
}

export function evaluateAnswer(expression, numbers) {
  if (!validNumbers(numbers)) {
    return { correct: false, error: 'This puzzle needs four numbers from 1 to 9.' };
  }
  if (typeof expression !== 'string' || !expression.trim()) {
    return { correct: false, error: 'Enter an expression.' };
  }
  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return { correct: false, error: 'Keep your expression to 160 characters or fewer.' };
  }

  try {
    let source = expression.trim()
      .replace(/[xX×]/g, '*')
      .replace(/÷/g, '/')
      .replace(/[−–—]/g, '-');
    const equals = source.indexOf('=');
    if (equals !== -1) {
      if (!/^=\s*24\s*$/.test(source.slice(equals))) {
        throw new Error('Only an optional =24 is allowed.');
      }
      source = source.slice(0, equals);
    }

    const tokens = tokenize(source);
    const remaining = numbers.slice();
    let position = 0;

    function parseFactor(depth) {
      const token = tokens[position];
      if (typeof token === 'number') {
        const occurrence = remaining.indexOf(token);
        if (occurrence === -1) throw new Error('Use each given number exactly once.');
        remaining.splice(occurrence, 1);
        position += 1;
        return rational(token);
      }
      if (token === '(') {
        if (depth >= MAX_DEPTH) throw new Error('Use fewer nested parentheses.');
        position += 1;
        const result = parseExpression(depth + 1);
        if (tokens[position] !== ')') throw new Error('Check your parentheses.');
        position += 1;
        return result;
      }
      if (token === '+' || token === '-') {
        throw new Error('Use + and − between numbers, not as unary signs.');
      }
      throw new Error('Expected a number or opening parenthesis.');
    }

    function parseTerm(depth) {
      let result = parseFactor(depth);
      while (tokens[position] === '*' || tokens[position] === '/') {
        const operator = tokens[position++];
        result = calculate(result, parseFactor(depth), operator);
      }
      return result;
    }

    function parseExpression(depth) {
      let result = parseTerm(depth);
      while (tokens[position] === '+' || tokens[position] === '-') {
        const operator = tokens[position++];
        result = calculate(result, parseTerm(depth), operator);
      }
      return result;
    }

    const result = parseExpression(0);
    if (position !== tokens.length) {
      if (tokens[position] === ')') throw new Error('Check your parentheses.');
      throw new Error('Add an operator between numbers or parentheses.');
    }
    if (remaining.length) throw new Error('Use each given number exactly once.');
    return result.numerator === 24 * result.denominator
      ? { correct: true }
      : { correct: false, error: 'Not 24. Try again.' };
  } catch (error) {
    return { correct: false, error: error.message };
  }
}

// All solvable multisets of four digits 1–9. Tiers estimate solution complexity:
// 1: shallow integer arithmetic; 2: deeper arithmetic or division; 3: fractions.
const SOLUTIONS = `1118|(1+1+1)*8|2
1126|(1+1)*2*6|1
1127|(1+2)*(1+7)|1
1128|(1+2)*1*8|1
1129|(1+2)*(9-1)|1
1134|(1+1)*3*4|1
1135|(1+3)*(1+5)|1
1136|(1+3)*1*6|1
1137|1*3*(1+7)|1
1138|1-1+3*8|1
1139|1*3*(9-1)|1
1144|(1+1+4)*4|2
1145|1*4*(1+5)|1
1146|1-1+4*6|1
1147|1*4*(7-1)|1
1148|(4-1)*1*8|1
1149|(4-1)*(9-1)|1
1155|5*5-1*1|1
1156|(5-1)*1*6|1
1157|(1+1)*(5+7)|1
1158|(5-1-1)*8|2
1166|(1+1)*(6+6)|1
1168|6*8/(1+1)|2
1169|6+(1+1)*9|2
1188|(1+1)*8+8|2
1224|(1+2)*2*4|1
1225|2*2*(1+5)|1
1226|1*2*2*6|1
1227|2*2*(7-1)|1
1228|(2-1+2)*8|2
1229|2*(1+2+9)|2
1233|(1+3)*2*3|1
1234|1*2*3*4|1
1235|2*3*(5-1)|1
1236|(3-1)*2*6|1
1237|1+2+3*7|1
1238|(2-1)*3*8|1
1239|1*2*(3+9)|1
1244|(2+4)*1*4|1
1245|(2+4)*(5-1)|1
1246|(2-1)*4*6|1
1247|2*(1+4+7)|2
1248|1*2*(4+8)|1
1249|2*(4-1+9)|2
1255|5*5-(2-1)|1
1256|(1+5)*(6-2)|1
1257|1*2*(5+7)|1
1258|(5-2)*1*8|1
1259|1+5+2*9|1
1266|(6-2)*1*6|1
1267|(6-2)*(7-1)|1
1268|(6-1-2)*8|2
1269|1*6+2*9|1
1277|(7*7-1)/2|2
1278|1+7+2*8|1
1279|2*7+1+9|1
1288|1*8+2*8|1
1289|2*8+9-1|1
1333|(1+3)*(3+3)|1
1334|(3-1)*3*4|1
1335|1*3*(3+5)|1
1336|3*(3-1+6)|2
1337|1*3+3*7|1
1338|3*(1+8)-3|2
1339|3*9-1*3|1
1344|1*3*(4+4)|1
1345|1+3+4*5|1
1346|6/(1-3/4)|3
1347|4-1+3*7|1
1348|(3-1)*(4+8)|1
1349|1*4*(9-3)|1
1356|1+5+3*6|1
1357|(1+5)*(7-3)|1
1358|3*5+1+8|1
1359|3*5+1*9|1
1366|1*6+3*6|1
1367|3*6+7-1|1
1368|(6-3)*1*8|1
1369|(6-3)*(9-1)|1
1377|(7-1)*(7-3)|1
1378|(7-1-3)*8|2
1379|(1+7)*(9/3)|2
1388|(1+3)*8-8|2
1389|1*8*(9/3)|2
1399|9/3*(9-1)|2
1444|(4-1)*(4+4)|1
1445|1*4+4*5|1
1446|4*(1+6)-4|2
1447|4*4+1+7|1
1448|4*4+1*8|1
1449|4*4+9-1|1
1455|4*5+5-1|1
1456|4/(1-5/6)|3
1457|4*7-(5-1)|1
1458|(1+5)*(8-4)|1
1459|(4-1)*5+9|2
1466|(1+4)*6-6|2
1467|6*(1+7-4)|2
1468|1*6*(8-4)|1
1469|6*(9-1-4)|2
1477|(1+7)*(7-4)|1
1478|(7-4)*1*8|1
1479|(7-4)*(9-1)|1
1488|4*8-1*8|1
1489|4*8-(9-1)|1
1555|(5-1/5)*5|3
1556|5*6-(1+5)|1
1559|(1+5)*(9-5)|1
1566|5*6-1*6|1
1567|5*6-(7-1)|1
1568|6*(1+8-5)|2
1569|1*6*(9-5)|1
1578|(1+7)*(8-5)|1
1579|(7-1)*(9-5)|1
1588|(8-5)*1*8|1
1589|(8-5)*(9-1)|1
1599|1+5+9+9|1
1666|(6-1)*6-6|2
1668|6/(1-6/8)|3
1669|6*(1+9-6)|2
1679|(1+7)*(9-6)|1
1688|(1+8-6)*8|2
1689|1+6+8+9|1
1699|1*6+9+9|1
1779|1+7+7+9|1
1788|1+7+8+8|1
1789|1*7+8+9|1
1799|7-1+9+9|1
1888|1*8+8+8|1
1889|8-1+8+9|1
2223|2*2*2*3|1
2224|2*2*(2+4)|1
2225|2*(2+2*5)|2
2227|2*(2*7-2)|2
2228|2*2*(8-2)|1
2229|2+2*(2+9)|2
2233|2*2*(3+3)|1
2234|3*(2*2+4)|2
2235|3*(2*5-2)|2
2236|2*3*(6-2)|1
2237|2*(2+3+7)|2
2238|2-2+3*8|1
2239|2*3+2*9|1
2244|(2*4-2)*4|2
2245|2*2+4*5|1
2246|2-2+4*6|1
2247|4*7-2*2|1
2248|2*4+2*8|1
2249|2+4+2*9|1
2255|2*(2+5+5)|2
2256|(5-2)*(2+6)|1
2257|2*5+2*7|1
2258|2*(5+8)-2|2
2259|2*(5-2+9)|2
2266|2*6+2*6|1
2267|2*(6+7)-2|2
2268|2+6+2*8|1
2269|2*(2*9-6)|2
2277|2*(7-2+7)|2
2278|2*7+2+8|1
2288|2*2*8-8|2
2289|8-2+2*9|1
2333|(2+3+3)*3|2
2335|2*(3*5-3)|2
2336|2*3+3*6|1
2337|2*3*(7-3)|1
2338|(3-2)*3*8|1
2339|3+3+2*9|1
2344|(4-2)*3*4|1
2345|2*(3+4+5)|2
2346|2+4+3*6|1
2347|(2+4)*(7-3)|1
2348|2*3*(8-4)|1
2349|(4-2)*(3+9)|1
2355|5*5-(3-2)|1
2356|5*6-2*3|1
2357|3*5+2+7|1
2358|3+5+2*8|1
2359|2*3*(9-5)|1
2366|(2+6)*(6-3)|1
2367|3*(2*7-6)|2
2368|3*6+8-2|1
2369|2*6+3+9|1
2377|2*7+3+7|1
2378|(7-3)*(8-2)|1
2379|2*(3*7-9)|2
2388|(8-2-3)*8|2
2389|8*(9-2*3)|2
2399|2*3+9+9|1
2444|2*4+4*4|1
2445|(4+4)*(5-2)|1
2446|4*4+2+6|1
2447|2*4*(7-4)|1
2448|4*8-2*4|1
2449|4*(9-2)-4|2
2455|4+2*(5+5)|2
2456|4*5+6-2|1
2457|(4-2)*(5+7)|1
2458|2*4*(8-5)|1
2459|(2+4)*(9-5)|1
2466|(6-4)*2*6|1
2467|4+6+2*7|1
2468|2*6+4+8|1
2469|4*9-2*6|1
2477|2*(7+7)-4|2
2478|4*(2*7-8)|2
2479|2*4+7+9|1
2488|2*4+8+8|1
2489|8*(9-2-4)|2
2499|2+4+9+9|1
2557|5+5+2*7|1
2558|(2+5/5)*8|2
2559|2*5+5+9|1
2566|(2*5-6)*6|2
2567|2*6+5+7|1
2568|2*5+6+8|1
2569|5*6/2+9|2
2577|2*5+7+7|1
2578|(2*5-7)*8|2
2579|5*7-(2+9)|1
2588|5*8-2*8|1
2589|2+5+8+9|1
2666|2*6+6+6|1
2667|6*(7-2)-6|2
2668|2*6*(8-6)|1
2669|(2+6)*(9-6)|1
2678|(2+7-6)*8|2
2679|2+6+7+9|1
2688|2+6+8+8|1
2689|8*(2*6-9)|2
2699|2*(9-6+9)|2
2778|2+7+7+8|1
2788|(2+8-7)*8|2
2789|2*(7+9)-8|2
2888|2*(8+8)-8|2
2889|8*(2+9-8)|2
2899|8-2+9+9|1
3333|3*3*3-3|2
3334|(3*3-3)*4|2
3335|3*3+3*5|1
3336|3+3+3*6|1
3337|(3+3)*(7-3)|1
3338|3-3+3*8|1
3339|3*(9-3/3)|2
3344|3*4+3*4|1
3345|3*4*(5-3)|1
3346|3-3+4*6|1
3347|3*(4-3+7)|2
3348|(4-3)*3*8|1
3349|3*4+3+9|1
3355|5*5-3/3|2
3356|3*5+3+6|1
3357|3*(3*5-7)|2
3359|(3+3)*(9-5)|1
3366|3*(6/3+6)|2
3367|6-3+3*7|1
3368|(3*3-6)*8|2
3369|3*3+6+9|1
3377|(3+3/7)*7|3
3378|3*3+7+8|1
3379|(7-3)*(9-3)|1
3388|8/(3-8/3)|3
3389|3*(3+8)-9|2
3399|3+3+9+9|1
3444|(3+4)*4-4|2
3445|4*4+3+5|1
3446|(4-3)*4*6|1
3447|4*(3+7-4)|2
3448|3*4+4+8|1
3449|4*9-3*4|1
3455|3*5+4+5|1
3456|(3+5-4)*6|2
3457|3*4+5+7|1
3458|(5-4)*3*8|1
3459|3*(4+9-5)|2
3466|3*4+6+6|1
3468|3*4*(8-6)|1
3469|(6-4)*(3+9)|1
3477|3*7+7-4|1
3478|4*(7-3)+8|2
3479|3*4*(9-7)|1
3489|3+4+8+9|1
3499|4*9-(3+9)|1
3556|3*(5+5)-6|2
3557|(5-3)*(5+7)|1
3558|5-5+3*8|1
3559|3*(9-5/5)|2
3566|(5-3)*(6+6)|1
3567|3*(6-5+7)|2
3568|(6-5)*3*8|1
3569|5*6-(9-3)|1
3578|3*7+8-5|1
3579|3+5+7+9|1
3588|3+5+8+8|1
3589|3*9-(8-5)|1
3599|(9-3)*(9-5)|1
3666|(6-3)*6+6|2
3667|6*7-3*6|1
3668|6-6+3*8|1
3669|3+6+6+9|1
3677|3*(7-6+7)|2
3678|3+6+7+8|1
3679|3*7+9-6|1
3688|6*8-3*8|1
3689|(8-6)*(3+9)|1
3699|3*9-(9-6)|1
3777|3+7+7+7|1
3778|7-7+3*8|1
3779|3*(9-7/7)|2
3788|(8-7)*3*8|1
3789|3*(7+9-8)|2
3799|(3+9)*(9-7)|1
3888|3*8+8-8|1
3889|3*8*(9-8)|1
3899|3*8+9-9|1
3999|9-3+9+9|1
4444|4*4+4+4|1
4445|4*(4/4+5)|2
4446|4-4+4*6|1
4447|(4+4)*(7-4)|1
4448|4*8-(4+4)|1
4449|4+4*(9-4)|2
4455|4*(5-4+5)|2
4456|(5-4)*4*6|1
4457|4*(4+7-5)|2
4458|4*5+8-4|1
4468|(6-4)*(4+8)|1
4469|(4+4)*(9-6)|1
4477|(4-4/7)*7|3
4478|4*7-(8-4)|1
4479|4+4+7+9|1
4488|4+4+8+8|1
4489|4*9-(4+8)|1
4555|5*5-(5-4)|1
4556|5-5+4*6|1
4557|4*(7-5/5)|2
4558|(4-5/5)*8|2
4559|4*5+9-5|1
4566|(6-5)*4*6|1
4567|(6-4)*(5+7)|1
4568|(4+5-6)*8|2
4569|4+5+6+9|1
4577|5*7-(4+7)|1
4578|4+5+7+8|1
4579|4*7-(9-5)|1
4588|(5-8/4)*8|2
4589|4*(5+9-8)|2
4599|4*(5+9/9)|2
4666|4*6+6-6|1
4667|4*6*(7-6)|1
4668|4+6+6+8|1
4669|4*9-(6+6)|1
4677|4*6+7-7|1
4678|4*6*(8-7)|1
4679|6*(7+9)/4|2
4688|4*6+8-8|1
4689|4*6*(9-8)|1
4699|4*6+9-9|1
4777|4*(7-7/7)|2
4778|4*(7+7-8)|2
4788|7*8-4*8|1
4789|(4+8)*(9-7)|1
4799|4*(7-9/9)|2
4888|(8-4)*8-8|2
4889|8*(4+8-9)|2
4899|8*(4-9/9)|2
5555|5*5-5/5|2
5556|5*5-(6-5)|1
5559|5+5+5+9|1
5566|(5+5-6)*6|2
5567|5*5-(7-6)|1
5568|5+5+6+8|1
5577|5+5+7+7|1
5578|5*5-(8-7)|1
5588|5*5-8/8|2
5589|5*5-(9-8)|1
5599|5*5-9/9|2
5666|(5-6/6)*6|2
5667|5+6+6+7|1
5668|6+6*(8-5)|2
5669|6*9-5*6|1
5677|6*(5-7/7)|2
5678|(5+7)*(8-6)|1
5679|6+(7-5)*9|2
5688|(5+6-8)*8|2
5689|6*(5+8-9)|2
5699|5*(9-6)+9|2
5779|(5+7)*(9-7)|1
5788|(7-5)*8+8|2
5789|5*8-(7+9)|1
5888|8*8-5*8|1
5889|8*(9-5)-8|2
6666|6+6+6+6|1
6668|(6+6)*(8-6)|1
6669|6+6*(9-6)|2
6679|(6+6)*(9-7)|1
6688|6*8/(8-6)|2
6689|6+(8-6)*9|2
6789|6*8/(9-7)|2
6799|6*7-(9+9)|1
6888|(8-6)*8+8|2
6889|8*9-6*8|1
6899|8*9/(9-6)|2
7889|8+8*(9-7)|2`.split('\n').map(row => {
  const [digits, expression, tier] = row.split('|');
  return { numbers: [...digits].map(Number), expression, difficulty: Number(tier) };
});
const SOLUTIONS_BY_NUMBERS = new Map(SOLUTIONS.map(solution => [
  solution.numbers.join(''), solution,
]));

export function solve(numbers) {
  if (!validNumbers(numbers)) return null;
  const solution = SOLUTIONS_BY_NUMBERS.get(numbers.slice().sort((a, b) => a - b).join(''));
  return solution ? { expression: solution.expression, difficulty: solution.difficulty } : null;
}

export function createDeck({ random = Math.random, difficulty = 'random' } = {}) {
  if (typeof difficulty === 'string' && /^[123]$/.test(difficulty)) {
    difficulty = Number(difficulty);
  }
  if (difficulty !== 'random' && ![1, 2, 3].includes(difficulty)) {
    throw new RangeError('Difficulty must be random, 1, 2, or 3.');
  }
  const pool = difficulty === 'random'
    ? SOLUTIONS
    : SOLUTIONS.filter(solution => solution.difficulty === difficulty);
  let cards = [];
  let position = 0;
  let previousCard;

  function shuffle(items) {
    for (let index = items.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [items[index], items[other]] = [items[other], items[index]];
    }
    return items;
  }

  return {
    next() {
      if (position === cards.length) {
        cards = shuffle(pool.slice());
        if (cards.length > 1 && cards[0] === previousCard) {
          [cards[0], cards[1]] = [cards[1], cards[0]];
        }
        position = 0;
      }
      const card = cards[position++];
      previousCard = card;
      return {
        numbers: shuffle(card.numbers.slice()),
        solution: card.expression,
        difficulty: card.difficulty,
      };
    },
  };
}
