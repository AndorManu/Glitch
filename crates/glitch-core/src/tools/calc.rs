//! The `calculate` tool: a small, safe arithmetic evaluator (small models are
//! bad at sums). No variables, no assignments, nothing but numbers: the input
//! is parsed, never executed.
//!
//! Supports `+ - * / ^ **` (also `x`, `×`, `÷`), parentheses, `15%` (= 0.15,
//! so "15% of 240" works), `a mod b`, `5!`, thousands separators ("1,234.5"),
//! `pi`, `e`, and sqrt, cbrt, abs, round(x[, digits]), floor, ceil, ln, log,
//! log2, exp, sin, cos, tan, asin, acos, atan (radians), min, max, pow.

use super::ToolError;

const MAX_INPUT: usize = 300;
const MAX_DEPTH: usize = 40;

pub fn evaluate(input: &str) -> Result<f64, ToolError> {
    if input.chars().count() > MAX_INPUT {
        return Err(ToolError("that expression is too long".into()));
    }
    let tokens = lex(input)?;
    if tokens.is_empty() {
        return Err(ToolError("there is nothing to calculate".into()));
    }
    let mut p = Parser { t: &tokens, i: 0, depth: 0 };
    let v = p.expr()?;
    if p.i != tokens.len() {
        return Err(ToolError(format!("I don't understand \"{}\" in that expression", tokens[p.i].text())));
    }
    if v.is_nan() {
        return Err(ToolError("that has no answer (not a number)".into()));
    }
    if v.is_infinite() {
        return Err(ToolError("the answer is infinite (division by zero?)".into()));
    }
    Ok(v)
}

/// A result as people write it: "36", "0.333333333", "1.5e+21".
pub fn format_number(v: f64) -> String {
    if v == 0.0 {
        return "0".into();
    }
    if v.fract() == 0.0 && v.abs() < 1e15 {
        return format!("{v:.0}");
    }
    if v.abs() >= 1e15 || v.abs() < 1e-6 {
        return format!("{v:e}");
    }
    let s = format!("{v:.10}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Op(char),
    LParen,
    RParen,
    Comma,
}

impl Tok {
    fn text(&self) -> String {
        match self {
            Tok::Num(n) => format_number(*n),
            Tok::Ident(s) => s.clone(),
            Tok::Op(c) => c.to_string(),
            Tok::LParen => "(".into(),
            Tok::RParen => ")".into(),
            Tok::Comma => ",".into(),
        }
    }
}

fn lex(input: &str) -> Result<Vec<Tok>, ToolError> {
    let chars: Vec<char> = input.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c.is_whitespace() || c == '=' || c == '?' || c == '$' || c == '€' || c == '£' {
            i += 1;
        } else if c.is_ascii_digit() || (c == '.' && chars.get(i + 1).is_some_and(char::is_ascii_digit)) {
            let mut s = String::new();
            while i < chars.len() {
                let d = chars[i];
                if d.is_ascii_digit() || d == '.' {
                    s.push(d);
                    i += 1;
                } else if d == ',' && thousands_group(&chars, i) {
                    i += 1; // "1,234"
                } else if (d == 'e' || d == 'E')
                    && chars.get(i + 1).is_some_and(|n| {
                        n.is_ascii_digit()
                            || ((*n == '-' || *n == '+') && chars.get(i + 2).is_some_and(char::is_ascii_digit))
                    })
                {
                    s.push('e');
                    s.push(chars[i + 1]);
                    i += 2;
                } else {
                    break;
                }
            }
            out.push(Tok::Num(s.parse().map_err(|_| ToolError(format!("\"{s}\" isn't a number")))?));
        } else if c.is_alphabetic() {
            let mut s = String::new();
            while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                s.extend(chars[i].to_lowercase());
                i += 1;
            }
            match s.as_str() {
                "x" | "times" => out.push(Tok::Op('*')),
                "of" => out.push(Tok::Op('*')), // "15% of 240"
                "mod" => out.push(Tok::Op('m')),
                _ => out.push(Tok::Ident(s)),
            }
        } else {
            let tok = match c {
                '+' | '-' | '/' | '^' | '%' | '!' => Tok::Op(c),
                '*' if chars.get(i + 1) == Some(&'*') => {
                    i += 1;
                    Tok::Op('^')
                }
                '*' | '×' | '·' => Tok::Op('*'),
                '÷' | ':' => Tok::Op('/'),
                '−' => Tok::Op('-'),
                '(' | '[' => Tok::LParen,
                ')' | ']' => Tok::RParen,
                ',' | ';' => Tok::Comma,
                other => return Err(ToolError(format!("I can't use \"{other}\" in a calculation"))),
            };
            out.push(tok);
            i += 1;
        }
    }
    Ok(out)
}

/// `,` at `i` separates thousands: exactly three digits follow, then no digit.
fn thousands_group(chars: &[char], i: usize) -> bool {
    (1..=3).all(|k| chars.get(i + k).is_some_and(char::is_ascii_digit))
        && !chars.get(i + 4).is_some_and(char::is_ascii_digit)
}

struct Parser<'a> {
    t: &'a [Tok],
    i: usize,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.t.get(self.i)
    }

    fn eat_op(&mut self, ops: &[char]) -> Option<char> {
        match self.peek() {
            Some(Tok::Op(c)) if ops.contains(c) => {
                let c = *c;
                self.i += 1;
                Some(c)
            }
            _ => None,
        }
    }

    fn deeper(&mut self) -> Result<(), ToolError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(ToolError("that expression is nested too deeply".into()));
        }
        Ok(())
    }

    fn expr(&mut self) -> Result<f64, ToolError> {
        self.deeper()?;
        let mut v = self.term()?;
        while let Some(op) = self.eat_op(&['+', '-']) {
            let r = self.term()?;
            v = if op == '+' { v + r } else { v - r };
        }
        self.depth -= 1;
        Ok(v)
    }

    fn term(&mut self) -> Result<f64, ToolError> {
        let mut v = self.unary()?;
        loop {
            if let Some(op) = self.eat_op(&['*', '/', 'm']) {
                let r = self.unary()?;
                v = match op {
                    '*' => v * r,
                    '/' => v / r,
                    _ => v % r,
                };
            } else if matches!(self.peek(), Some(Tok::LParen | Tok::Ident(_))) {
                // Implicit multiplication: "2(3+4)", "2pi".
                v *= self.unary()?;
            } else {
                return Ok(v);
            }
        }
    }

    fn unary(&mut self) -> Result<f64, ToolError> {
        match self.eat_op(&['-', '+']) {
            Some('-') => {
                self.deeper()?;
                let v = -self.unary()?;
                self.depth -= 1;
                Ok(v)
            }
            Some(_) => self.unary(),
            None => self.power(),
        }
    }

    fn power(&mut self) -> Result<f64, ToolError> {
        let base = self.postfix()?;
        if self.eat_op(&['^']).is_some() {
            self.deeper()?;
            let exp = self.unary()?; // right-associative: 2^3^2 = 2^9
            self.depth -= 1;
            return Ok(base.powf(exp));
        }
        Ok(base)
    }

    fn postfix(&mut self) -> Result<f64, ToolError> {
        let mut v = self.primary()?;
        loop {
            if self.eat_op(&['%']).is_some() {
                v /= 100.0;
            } else if self.eat_op(&['!']).is_some() {
                v = factorial(v)?;
            } else {
                return Ok(v);
            }
        }
    }

    fn primary(&mut self) -> Result<f64, ToolError> {
        match self.t.get(self.i).cloned() {
            Some(Tok::Num(n)) => {
                self.i += 1;
                Ok(n)
            }
            Some(Tok::LParen) => {
                self.i += 1;
                let v = self.expr()?;
                self.close()?;
                Ok(v)
            }
            Some(Tok::Ident(name)) => {
                self.i += 1;
                match name.as_str() {
                    "pi" | "π" => return Ok(std::f64::consts::PI),
                    "e" => return Ok(std::f64::consts::E),
                    _ => {}
                }
                let args = self.args(&name)?;
                call(&name, &args)
            }
            Some(t) => Err(ToolError(format!("I didn't expect \"{}\" there", t.text()))),
            None => Err(ToolError("the expression ends too early".into())),
        }
    }

    fn close(&mut self) -> Result<(), ToolError> {
        if self.peek() == Some(&Tok::RParen) {
            self.i += 1;
            Ok(())
        } else {
            Err(ToolError("a closing bracket is missing".into()))
        }
    }

    /// Function arguments: "(a, b)", or a single value without brackets ("sqrt 16").
    fn args(&mut self, name: &str) -> Result<Vec<f64>, ToolError> {
        if self.peek() != Some(&Tok::LParen) {
            if self.peek().is_none() {
                return Err(ToolError(format!("\"{name}\" needs a number")));
            }
            return Ok(vec![self.power()?]);
        }
        self.i += 1;
        let mut args = vec![self.expr()?];
        while self.peek() == Some(&Tok::Comma) {
            self.i += 1;
            args.push(self.expr()?);
        }
        self.close()?;
        Ok(args)
    }
}

fn factorial(v: f64) -> Result<f64, ToolError> {
    if v < 0.0 || v.fract() != 0.0 || v > 170.0 {
        return Err(ToolError("factorials only work for whole numbers from 0 to 170".into()));
    }
    Ok((1..=v as u64).fold(1.0, |acc, k| acc * k as f64))
}

fn call(name: &str, a: &[f64]) -> Result<f64, ToolError> {
    let one = |f: fn(f64) -> f64| -> Result<f64, ToolError> {
        match a {
            [x] => Ok(f(*x)),
            _ => Err(ToolError(format!("{name} takes one number"))),
        }
    };
    match name {
        "sqrt" => one(f64::sqrt),
        "cbrt" => one(f64::cbrt),
        "abs" => one(f64::abs),
        "floor" => one(f64::floor),
        "ceil" => one(f64::ceil),
        "ln" => one(f64::ln),
        "log" | "log10" => one(f64::log10),
        "log2" => one(f64::log2),
        "exp" => one(f64::exp),
        "sin" => one(f64::sin),
        "cos" => one(f64::cos),
        "tan" => one(f64::tan),
        "asin" => one(f64::asin),
        "acos" => one(f64::acos),
        "atan" => one(f64::atan),
        "round" => match a {
            [x] => Ok(x.round()),
            [x, d] if (0.0..=12.0).contains(d) => {
                let m = 10f64.powi(*d as i32);
                Ok((x * m).round() / m)
            }
            _ => Err(ToolError("round takes a number and optionally 0-12 decimal places".into())),
        },
        "min" | "max" if !a.is_empty() => {
            let it = a.iter().copied();
            Ok(if name == "min" { it.fold(f64::INFINITY, f64::min) } else { it.fold(f64::NEG_INFINITY, f64::max) })
        }
        "pow" => match a {
            [x, y] => Ok(x.powf(*y)),
            _ => Err(ToolError("pow takes two numbers".into())),
        },
        _ => Err(ToolError(format!("I don't know \"{name}\"; I only do arithmetic"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str) -> f64 {
        evaluate(s).unwrap_or_else(|e| panic!("{s}: {e}"))
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert_eq!(ev("1 + 2 * 3"), 7.0);
        assert_eq!(ev("(1 + 2) * 3"), 9.0);
        assert_eq!(ev("2^3^2"), 512.0);
        assert_eq!(ev("2**10"), 1024.0);
        assert_eq!(ev("-3^2"), -9.0);
        assert_eq!(ev("10 / 4"), 2.5);
        assert_eq!(ev("7 mod 3"), 1.0);
        assert_eq!(ev("5!"), 120.0);
        assert_eq!(ev("2(3+4)"), 14.0);
        assert_eq!(ev("12 x 3"), 36.0);
        assert_eq!(ev("12 × 3 ÷ 4"), 9.0);
    }

    #[test]
    fn percentages_and_thousands() {
        assert_eq!(ev("15% of 240"), 36.0);
        assert_eq!(ev("0.15 * 240"), 36.0);
        assert_eq!(ev("240 * 15%"), 36.0);
        assert_eq!(ev("1,234.5 + 1"), 1235.5);
        assert_eq!(ev("$1,299.00 * 15%"), 194.85);
        assert_eq!(ev("max(1, 2,3)"), 3.0);
        assert_eq!(ev("pow(2, 8)"), 256.0);
    }

    #[test]
    fn functions_and_constants() {
        assert_eq!(ev("sqrt(16)"), 4.0);
        assert_eq!(ev("sqrt 16 + 1"), 5.0);
        assert!((ev("2pi") - std::f64::consts::TAU).abs() < 1e-12);
        assert_eq!(ev("round(2.71828, 2)"), 2.72);
        assert_eq!(ev("log(1000)"), 3.0);
        assert_eq!(ev("1e3 + 1"), 1001.0);
    }

    #[test]
    fn nonsense_is_rejected_not_run() {
        for bad in
            ["", "1 +", "(1 + 2", "rm -rf /", "import os", "2 & 3", "sqrt()", "1/0", "(-1)^0.5", "171!", "foo(2)"]
        {
            assert!(evaluate(bad).is_err(), "{bad:?} should fail");
        }
        assert!(evaluate(&"(".repeat(100)).is_err());
        assert!(evaluate(&"1+".repeat(200)).is_err());
    }

    #[test]
    fn numbers_print_like_people_write_them() {
        assert_eq!(format_number(36.0), "36");
        assert_eq!(format_number(1.0 / 3.0), "0.3333333333");
        assert_eq!(format_number(194.85), "194.85");
        assert_eq!(format_number(-2.5), "-2.5");
        assert_eq!(format_number(1e21), "1e21");
    }
}
