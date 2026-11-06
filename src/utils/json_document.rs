//! Port of `src/utils/json-document.ts`.
//!
//! JSONC parsing and path edits follow `jsonc-parser` closely enough for hook
//! settings: comments, trailing commas, BOM-tolerant reads, and surgical edits
//! that keep bytes outside the edited node. Strict JSON uses `serde_json`, so
//! its error text is serde's rather than V8's `JSON.parse` message.

use serde_json::{Map, Value};
use std::io;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonSyntax {
    Json,
    Jsonc,
}

#[derive(Debug, Clone)]
pub enum JsonPathSeg {
    Key(String),
    Index(usize),
}

#[derive(Debug)]
pub struct JsonParseError {
    pub message: String,
}

impl std::fmt::Display for JsonParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for JsonParseError {}

#[derive(Debug)]
pub enum JsonDocumentRead {
    Ok { data: Value, raw: String },
    Empty { raw: String },
    Missing,
    Error { error: JsonParseError },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormattingOptions {
    pub insert_spaces: bool,
    pub tab_size: usize,
    pub eol: String,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct JsonEditOptions {
    pub is_array_insertion: bool,
}

pub fn parse_json_document(raw: &str, syntax: JsonSyntax) -> Result<Value, JsonParseError> {
    let text = strip_bom(raw);
    match syntax {
        JsonSyntax::Json => serde_json::from_str(text).map_err(|err| JsonParseError {
            message: err.to_string(),
        }),
        JsonSyntax::Jsonc => parse_cst(text)
            .map(|tree| tree.value)
            .map_err(|err| JsonParseError {
                message: format!("invalid JSONC: {} at offset {}", err.code, err.offset),
            }),
    }
}

pub async fn read_json_document(path: &str, syntax: JsonSyntax) -> JsonDocumentRead {
    let bytes = match tokio::fs::read(path).await {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return JsonDocumentRead::Missing,
        Err(err) => {
            return JsonDocumentRead::Error {
                error: JsonParseError {
                    message: err.to_string(),
                },
            }
        }
    };
    let raw = match String::from_utf8(bytes) {
        Ok(text) => text,
        Err(err) => {
            return JsonDocumentRead::Error {
                error: JsonParseError {
                    message: err.to_string(),
                },
            }
        }
    };
    if js_trim(&raw).is_empty() {
        return JsonDocumentRead::Empty { raw };
    }
    match parse_json_document(&raw, syntax) {
        Ok(data) => JsonDocumentRead::Ok { data, raw },
        Err(error) => JsonDocumentRead::Error { error },
    }
}

pub fn detect_json_formatting(raw: &str) -> FormattingOptions {
    let eol = if raw.contains("\r\n") { "\r\n" } else { "\n" }.to_string();
    let indent = detect_indent(raw);
    if indent.as_ref().is_some_and(|text| text.contains('\t')) {
        return FormattingOptions {
            insert_spaces: false,
            tab_size: 1,
            eol,
        };
    }
    FormattingOptions {
        insert_spaces: true,
        tab_size: indent
            .map(|text| text.chars().count())
            .filter(|count| *count > 0)
            .unwrap_or(2),
        eol,
    }
}

pub fn edit_jsonc(
    raw: &str,
    path: &[JsonPathSeg],
    value: Option<&Value>,
    options: JsonEditOptions,
) -> String {
    let fmt = detect_json_formatting(raw);
    let Ok(tree) = parse_cst(raw) else {
        return raw.to_string();
    };
    edit_at(raw, &tree, path, value, options.is_array_insertion, &fmt, 0)
}

fn detect_indent(raw: &str) -> Option<String> {
    for line in raw.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let mut indent = String::new();
        for ch in line.chars() {
            if ch == ' ' || ch == '\t' {
                indent.push(ch);
            } else if !indent.is_empty() && (ch == '"' || ch == '}') {
                return Some(indent);
            } else {
                break;
            }
        }
    }
    None
}

fn strip_bom(text: &str) -> &str {
    text.strip_prefix('\u{feff}').unwrap_or(text)
}

fn js_trim(text: &str) -> &str {
    let start = text
        .find(|ch: char| !is_js_whitespace(ch))
        .unwrap_or(text.len());
    let end = text
        .rfind(|ch: char| !is_js_whitespace(ch))
        .map(|index| {
            index
                + text[index..]
                    .chars()
                    .next()
                    .map(|ch| ch.len_utf8())
                    .unwrap_or(0)
        })
        .unwrap_or(0);
    if start >= end {
        ""
    } else {
        &text[start..end]
    }
}

fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{feff}'
            | '\n'
            | '\r'
            | '\u{2028}'
            | '\u{2029}'
    ) || unicode_space(ch)
}

fn unicode_space(ch: char) -> bool {
    matches!(
        ch,
        '\u{1680}'
            | '\u{2000}'
            | '\u{2001}'
            | '\u{2002}'
            | '\u{2003}'
            | '\u{2004}'
            | '\u{2005}'
            | '\u{2006}'
            | '\u{2007}'
            | '\u{2008}'
            | '\u{2009}'
            | '\u{200a}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

struct ParseErr {
    code: &'static str,
    offset: usize,
}

struct Parser<'a> {
    s: &'a str,
    i: usize,
    err: Option<ParseErr>,
}

struct Cst {
    start: usize,
    end: usize,
    value: Value,
    kind: Kind,
}

enum Kind {
    Leaf,
    Object(Vec<Field>),
    Array(Vec<Cst>),
}

struct Field {
    key: String,
    key_start: usize,
    value: Cst,
}

impl<'a> Parser<'a> {
    fn eof(&self) -> bool {
        self.i >= self.s.len()
    }

    fn peek(&self) -> Option<char> {
        self.s[self.i..].chars().next()
    }

    fn bump(&mut self) -> Option<char> {
        let ch = self.peek()?;
        self.i += ch.len_utf8();
        Some(ch)
    }

    fn consume(&mut self, expected: char) -> bool {
        if self.peek() == Some(expected) {
            self.bump();
            true
        } else {
            false
        }
    }

    fn fail(&mut self, code: &'static str) {
        if self.err.is_none() {
            let offset = self.s[..self.i.min(self.s.len())].chars().count();
            self.err = Some(ParseErr { code, offset });
        }
    }

    fn skip(&mut self) -> bool {
        loop {
            if self.eof() {
                return self.err.is_none();
            }
            match self.peek() {
                Some(ch) if is_json_space(ch) => {
                    self.bump();
                }
                Some('/') => {
                    if !self.skip_comment() {
                        return false;
                    }
                }
                _ => return self.err.is_none(),
            }
        }
    }

    fn skip_comment(&mut self) -> bool {
        let next = self.s[self.i..].chars().nth(1);
        if next == Some('/') {
            self.bump();
            self.bump();
            while let Some(ch) = self.peek() {
                if ch == '\n' || ch == '\r' {
                    break;
                }
                self.bump();
            }
            return true;
        }
        if next == Some('*') {
            self.bump();
            self.bump();
            loop {
                match self.peek() {
                    None => {
                        self.fail("UnexpectedEndOfComment");
                        return false;
                    }
                    Some('*') => {
                        self.bump();
                        if self.peek() == Some('/') {
                            self.bump();
                            return true;
                        }
                    }
                    Some(_) => {
                        self.bump();
                    }
                }
            }
        }
        self.fail("InvalidCommentToken");
        false
    }

    fn parse_value(&mut self) -> Result<Cst, ()> {
        if !self.skip() {
            return Err(());
        }
        match self.peek() {
            None => {
                self.fail("ValueExpected");
                Err(())
            }
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => {
                let (text, start, end) = self.parse_string()?;
                Ok(Cst {
                    start,
                    end,
                    value: Value::String(text),
                    kind: Kind::Leaf,
                })
            }
            Some('t') => self.parse_literal("true", Value::Bool(true)),
            Some('f') => self.parse_literal("false", Value::Bool(false)),
            Some('n') => self.parse_literal("null", Value::Null),
            Some('-') | Some('0'..='9') => self.parse_number(),
            Some(_) => {
                self.fail("ValueExpected");
                Err(())
            }
        }
    }

    fn parse_literal(&mut self, literal: &str, value: Value) -> Result<Cst, ()> {
        let start = self.i;
        if self.s[self.i..].starts_with(literal) {
            self.i += literal.len();
            Ok(Cst {
                start,
                end: self.i,
                value,
                kind: Kind::Leaf,
            })
        } else {
            self.fail("InvalidSymbol");
            Err(())
        }
    }

    fn parse_object(&mut self) -> Result<Cst, ()> {
        let start = self.i;
        self.bump();
        let mut fields = Vec::new();
        if !self.skip() {
            return Err(());
        }
        if self.consume('}') {
            return Ok(Cst {
                start,
                end: self.i,
                value: Value::Object(Map::new()),
                kind: Kind::Object(fields),
            });
        }
        loop {
            if !self.skip() {
                return Err(());
            }
            if self.peek() != Some('"') {
                self.fail("PropertyNameExpected");
                return Err(());
            }
            let (key, key_start, _) = self.parse_string()?;
            if !self.skip() {
                return Err(());
            }
            if !self.consume(':') {
                self.fail("ColonExpected");
                return Err(());
            }
            let value = self.parse_value()?;
            fields.push(Field {
                key,
                key_start,
                value,
            });
            if !self.skip() {
                return Err(());
            }
            if self.consume(',') {
                if !self.skip() {
                    return Err(());
                }
                if self.consume('}') {
                    break;
                }
                continue;
            }
            if self.consume('}') {
                break;
            }
            self.fail("CommaExpected");
            return Err(());
        }
        let mut map = Map::new();
        for field in &fields {
            map.insert(field.key.clone(), field.value.value.clone());
        }
        Ok(Cst {
            start,
            end: self.i,
            value: Value::Object(map),
            kind: Kind::Object(fields),
        })
    }

    fn parse_array(&mut self) -> Result<Cst, ()> {
        let start = self.i;
        self.bump();
        let mut items = Vec::new();
        if !self.skip() {
            return Err(());
        }
        if self.consume(']') {
            return Ok(Cst {
                start,
                end: self.i,
                value: Value::Array(Vec::new()),
                kind: Kind::Array(items),
            });
        }
        loop {
            items.push(self.parse_value()?);
            if !self.skip() {
                return Err(());
            }
            if self.consume(',') {
                if !self.skip() {
                    return Err(());
                }
                if self.consume(']') {
                    break;
                }
                continue;
            }
            if self.consume(']') {
                break;
            }
            self.fail("CommaExpected");
            return Err(());
        }
        let values = items.iter().map(|item| item.value.clone()).collect();
        Ok(Cst {
            start,
            end: self.i,
            value: Value::Array(values),
            kind: Kind::Array(items),
        })
    }

    fn parse_string(&mut self) -> Result<(String, usize, usize), ()> {
        let start = self.i;
        if !self.consume('"') {
            self.fail("InvalidSymbol");
            return Err(());
        }
        let mut out = String::new();
        loop {
            match self.peek() {
                None => {
                    self.fail("UnexpectedEndOfString");
                    return Err(());
                }
                Some('"') => {
                    self.bump();
                    break;
                }
                Some('\\') => {
                    self.bump();
                    match self.bump() {
                        Some('"') => out.push('"'),
                        Some('\\') => out.push('\\'),
                        Some('/') => out.push('/'),
                        Some('b') => out.push('\u{0008}'),
                        Some('f') => out.push('\u{000c}'),
                        Some('n') => out.push('\n'),
                        Some('r') => out.push('\r'),
                        Some('t') => out.push('\t'),
                        Some('u') => {
                            let unit = self.read_hex4()?;
                            match char::from_u32(unit) {
                                Some(ch) if !(0xD800..=0xDFFF).contains(&unit) => out.push(ch),
                                _ => {
                                    self.fail("InvalidUnicode");
                                    return Err(());
                                }
                            }
                        }
                        _ => {
                            self.fail("InvalidEscapeCharacter");
                            return Err(());
                        }
                    }
                }
                Some(ch) if (ch as u32) < 0x20 => {
                    self.fail("InvalidCharacter");
                    return Err(());
                }
                Some(ch) => {
                    self.bump();
                    out.push(ch);
                }
            }
        }
        Ok((out, start, self.i))
    }

    fn read_hex4(&mut self) -> Result<u32, ()> {
        let mut value = 0u32;
        for _ in 0..4 {
            let Some(ch) = self.bump() else {
                self.fail("InvalidUnicode");
                return Err(());
            };
            let Some(digit) = ch.to_digit(16) else {
                self.fail("InvalidUnicode");
                return Err(());
            };
            value = (value << 4) | digit;
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<Cst, ()> {
        let start = self.i;
        if self.peek() == Some('-') {
            self.bump();
        }
        match self.peek() {
            Some('0') => {
                self.bump();
            }
            Some('1'..='9') => {
                while matches!(self.peek(), Some('0'..='9')) {
                    self.bump();
                }
            }
            _ => {
                self.fail("InvalidNumberFormat");
                return Err(());
            }
        }
        if self.peek() == Some('.') {
            self.bump();
            if !matches!(self.peek(), Some('0'..='9')) {
                self.fail("InvalidNumberFormat");
                return Err(());
            }
            while matches!(self.peek(), Some('0'..='9')) {
                self.bump();
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            self.bump();
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.bump();
            }
            if !matches!(self.peek(), Some('0'..='9')) {
                self.fail("InvalidNumberFormat");
                return Err(());
            }
            while matches!(self.peek(), Some('0'..='9')) {
                self.bump();
            }
        }
        let text = &self.s[start..self.i];
        match serde_json::from_str::<Value>(text) {
            Ok(value) => Ok(Cst {
                start,
                end: self.i,
                value,
                kind: Kind::Leaf,
            }),
            Err(_) => {
                self.fail("InvalidNumberFormat");
                Err(())
            }
        }
    }
}

fn is_json_space(ch: char) -> bool {
    matches!(ch, ' ' | '\t' | '\n' | '\r' | '\u{feff}')
}

fn parse_cst(raw: &str) -> Result<Cst, ParseErr> {
    let mut parser = Parser {
        s: raw,
        i: 0,
        err: None,
    };
    if !parser.skip() {
        return Err(parser.err.unwrap_or(ParseErr {
            code: "ValueExpected",
            offset: 0,
        }));
    }
    if parser.eof() {
        parser.fail("ValueExpected");
        return Err(parser.err.unwrap());
    }
    let value = match parser.parse_value() {
        Ok(value) => value,
        Err(()) => {
            return Err(parser.err.unwrap_or(ParseErr {
                code: "ValueExpected",
                offset: 0,
            }))
        }
    };
    if !parser.skip() {
        return Err(parser.err.unwrap_or(ParseErr {
            code: "ValueExpected",
            offset: 0,
        }));
    }
    if !parser.eof() {
        parser.fail("EndOfFileExpected");
        return Err(parser.err.unwrap());
    }
    Ok(value)
}

fn edit_at(
    raw: &str,
    node: &Cst,
    path: &[JsonPathSeg],
    value: Option<&Value>,
    array_insert: bool,
    fmt: &FormattingOptions,
    depth: usize,
) -> String {
    let Some(segment) = path.first() else {
        return match value {
            Some(value) => splice(raw, node.start, node.end, &render(value, fmt, depth)),
            None => raw.to_string(),
        };
    };
    match (&node.kind, segment) {
        (Kind::Object(fields), JsonPathSeg::Key(key)) => {
            if let Some(index) = fields.iter().rposition(|field| &field.key == key) {
                if path.len() == 1 {
                    if let Some(value) = value {
                        let field = &fields[index];
                        splice(
                            raw,
                            field.value.start,
                            field.value.end,
                            &render(value, fmt, depth + 1),
                        )
                    } else {
                        remove_property(raw, node, fields, index)
                    }
                } else {
                    edit_at(
                        raw,
                        &fields[index].value,
                        &path[1..],
                        value,
                        array_insert,
                        fmt,
                        depth + 1,
                    )
                }
            } else if let Some(value) = value {
                let wrapped = wrap(&path[1..], value);
                insert_property(raw, node, fields, key, &wrapped, fmt, depth)
            } else {
                raw.to_string()
            }
        }
        (Kind::Array(items), JsonPathSeg::Index(index)) => {
            if path.len() > 1 {
                if let Some(item) = items.get(*index) {
                    return edit_at(raw, item, &path[1..], value, array_insert, fmt, depth + 1);
                }
                return raw.to_string();
            }
            edit_array(raw, node, *index, value, array_insert, fmt, depth)
        }
        _ => raw.to_string(),
    }
}

fn wrap(path: &[JsonPathSeg], value: &Value) -> Value {
    let Some(segment) = path.first() else {
        return value.clone();
    };
    match segment {
        JsonPathSeg::Key(key) => {
            let mut map = Map::new();
            map.insert(key.clone(), wrap(&path[1..], value));
            Value::Object(map)
        }
        JsonPathSeg::Index(index) => {
            let mut items = vec![Value::Null; *index];
            items.push(wrap(&path[1..], value));
            Value::Array(items)
        }
    }
}

fn insert_property(
    raw: &str,
    node: &Cst,
    fields: &[Field],
    key: &str,
    value: &Value,
    fmt: &FormattingOptions,
    depth: usize,
) -> String {
    let close = node.end.saturating_sub(1);
    if raw.as_bytes().get(close) != Some(&b'}') {
        return raw.to_string();
    }
    let rendered = render(value, fmt, depth + 1);
    let key_json = serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string());
    let prop_indent = indent_text(fmt, depth + 1);
    let base_indent = indent_text(fmt, depth);
    if fields.is_empty() {
        let insertion = format!(
            "{}{prop_indent}{key_json}: {rendered}{}{base_indent}",
            fmt.eol, fmt.eol
        );
        return splice(raw, close, close, &insertion);
    }
    let last = fields.last().expect("fields");
    let (base, close_at) = if find_comma_forward(raw, last.value.end, node.end).is_none() {
        (splice(raw, last.value.end, last.value.end, ","), close + 1)
    } else {
        (raw.to_string(), close)
    };
    let insertion = format!("{}{prop_indent}{key_json}: {rendered}", fmt.eol);
    splice(&base, close_at, close_at, &insertion)
}

fn remove_property(raw: &str, node: &Cst, fields: &[Field], index: usize) -> String {
    let field = &fields[index];
    remove_span(raw, node.start, node.end, field.key_start, field.value.end)
}

fn edit_array(
    raw: &str,
    node: &Cst,
    index: usize,
    value: Option<&Value>,
    array_insert: bool,
    fmt: &FormattingOptions,
    depth: usize,
) -> String {
    let Kind::Array(items) = &node.kind else {
        return raw.to_string();
    };
    let Some(value) = value else {
        let Some(item) = items.get(index) else {
            return raw.to_string();
        };
        return remove_span(raw, node.start, node.end, item.start, item.end);
    };
    let rendered = render(value, fmt, depth + 1);
    if items.is_empty() {
        let open = node.start + 1;
        return splice(raw, open, open, &rendered);
    }
    if index >= items.len() {
        return append_array_item(raw, node, items, &rendered);
    }
    let item = &items[index];
    if array_insert {
        splice(raw, item.start, item.start, &format!("{rendered}, "))
    } else {
        splice(raw, item.start, item.end, &rendered)
    }
}

fn append_array_item(raw: &str, node: &Cst, items: &[Cst], rendered: &str) -> String {
    let last = items.last().expect("items");
    if let Some(comma) = find_comma_forward(raw, last.end, node.end) {
        splice(raw, comma + 1, comma + 1, &format!(" {rendered}"))
    } else {
        splice(raw, last.end, last.end, &format!(", {rendered}"))
    }
}

fn remove_span(raw: &str, node_start: usize, node_end: usize, start: usize, end: usize) -> String {
    if let Some(comma) = find_comma_forward(raw, end, node_end) {
        return splice(raw, start, comma + 1, "");
    }
    if let Some(comma) = find_comma_backward(raw, start, node_start) {
        return splice(raw, comma, end, "");
    }
    splice(raw, start, end, "")
}

fn find_comma_forward(raw: &str, mut index: usize, limit: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    while index < limit && index < bytes.len() {
        match bytes[index] {
            b' ' | b'\t' | b'\n' | b'\r' => index += 1,
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'/' => {
                index += 2;
                while index < limit
                    && index < bytes.len()
                    && bytes[index] != b'\n'
                    && bytes[index] != b'\r'
                {
                    index += 1;
                }
            }
            b'/' if index + 1 < bytes.len() && bytes[index + 1] == b'*' => {
                index += 2;
                while index + 1 < limit
                    && index + 1 < bytes.len()
                    && !(bytes[index] == b'*' && bytes[index + 1] == b'/')
                {
                    index += 1;
                }
                if index + 1 < bytes.len() {
                    index += 2;
                }
            }
            b',' => return Some(index),
            _ => return None,
        }
    }
    None
}

fn find_comma_backward(raw: &str, start: usize, low: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    let mut index = start;
    while index > low {
        index -= 1;
        match bytes.get(index).copied() {
            Some(b' ' | b'\t' | b'\n' | b'\r') => continue,
            Some(b',') => return Some(index),
            _ => return None,
        }
    }
    None
}

fn splice(raw: &str, start: usize, end: usize, insert: &str) -> String {
    let mut out = String::with_capacity(raw.len() + insert.len());
    out.push_str(&raw[..start]);
    out.push_str(insert);
    out.push_str(&raw[end..]);
    out
}

fn render(value: &Value, fmt: &FormattingOptions, depth: usize) -> String {
    match value {
        Value::Object(map) if !map.is_empty() => render_object(map, fmt, depth),
        Value::Array(items) if !items.is_empty() => render_array(items, fmt, depth),
        other => serde_json::to_string(other).unwrap_or_else(|_| "null".to_string()),
    }
}

fn render_object(map: &Map<String, Value>, fmt: &FormattingOptions, depth: usize) -> String {
    let mut out = String::from("{");
    out.push_str(&fmt.eol);
    let mut first = true;
    for (key, value) in map {
        if !first {
            out.push(',');
            out.push_str(&fmt.eol);
        }
        first = false;
        out.push_str(&indent_text(fmt, depth + 1));
        out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
        out.push_str(": ");
        out.push_str(&render(value, fmt, depth + 1));
    }
    out.push_str(&fmt.eol);
    out.push_str(&indent_text(fmt, depth));
    out.push('}');
    out
}

fn render_array(items: &[Value], fmt: &FormattingOptions, depth: usize) -> String {
    let mut out = String::from("[");
    out.push_str(&fmt.eol);
    for (index, value) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
            out.push_str(&fmt.eol);
        }
        out.push_str(&indent_text(fmt, depth + 1));
        out.push_str(&render(value, fmt, depth + 1));
    }
    out.push_str(&fmt.eol);
    out.push_str(&indent_text(fmt, depth));
    out.push(']');
    out
}

fn indent_text(fmt: &FormattingOptions, depth: usize) -> String {
    let unit = if fmt.insert_spaces {
        " ".repeat(fmt.tab_size.max(1))
    } else {
        "\t".repeat(fmt.tab_size.max(1))
    };
    unit.repeat(depth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn with_bom(text: &str) -> String {
        format!("\u{feff}{text}")
    }

    #[test]
    fn parses_bom_prefixed_strict_json() {
        let parsed =
            parse_json_document(&with_bom(r#"{"model":"pilot"}"#), JsonSyntax::Json).unwrap();
        assert_eq!(parsed["model"], "pilot");
    }

    #[test]
    fn parses_bom_prefixed_jsonc_with_comments_and_trailing_commas() {
        let raw = with_bom("{\n  // pilot\n  \"hooks\": {\"a\": 1},\n}");
        let parsed = parse_json_document(&raw, JsonSyntax::Jsonc).unwrap();
        assert_eq!(parsed["hooks"]["a"], 1);
    }

    #[test]
    fn reports_malformed_content_as_an_error() {
        assert!(parse_json_document(&with_bom(r#"{"a":"#), JsonSyntax::Json).is_err());
        assert!(parse_json_document(r#"{"a":"#, JsonSyntax::Json).is_err());
        let err = parse_json_document(&with_bom(r#"{"a": }"#), JsonSyntax::Jsonc).unwrap_err();
        assert!(err.message.starts_with("invalid JSONC:"));
        assert!(err.message.contains("at offset"));
        assert!(parse_json_document(&with_bom(r#"{"a": }"#), JsonSyntax::Jsonc).is_err());
    }

    #[test]
    fn strips_only_a_leading_bom_inside_parse() {
        let raw = format!("{{\"note\":\"a{}b\"}}", '\u{feff}');
        let parsed = parse_json_document(&raw, JsonSyntax::Json).unwrap();
        assert_eq!(parsed["note"], "a\u{feff}b");
    }

    #[tokio::test]
    async fn returns_the_bom_in_raw_while_parsing() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("settings.json");
        let mut bytes = vec![0xef, 0xbb, 0xbf];
        bytes.extend(b"{\"model\":\"pilot\"}\n");
        tokio::fs::write(&target, bytes).await.unwrap();
        let doc = read_json_document(target.to_str().unwrap(), JsonSyntax::Json).await;
        match doc {
            JsonDocumentRead::Ok { data, raw } => {
                assert_eq!(data["model"], "pilot");
                assert_eq!(raw, "\u{feff}{\"model\":\"pilot\"}\n");
                assert_eq!(raw, tokio::fs::read_to_string(&target).await.unwrap());
            }
            other => panic!("expected ok, got {other:?}"),
        }
    }

    #[test]
    fn edit_jsonc_round_trips_bom_prefixed_text() {
        let raw = "\u{feff}{\n  \"model\": \"old\"\n}\n";
        let next = edit_jsonc(
            raw,
            &[JsonPathSeg::Key("model".into())],
            Some(&Value::String("pilot".into())),
            JsonEditOptions::default(),
        );
        assert!(next.starts_with('\u{feff}'));
        let parsed = parse_json_document(&next, JsonSyntax::Jsonc).unwrap();
        assert_eq!(parsed["model"], "pilot");
    }

    #[test]
    fn edit_jsonc_inserts_a_missing_path_and_can_delete_it() {
        let raw = "{}\n";
        let inserted = edit_jsonc(
            raw,
            &[
                JsonPathSeg::Key("hooks".into()),
                JsonPathSeg::Key("PostToolUse".into()),
            ],
            Some(&serde_json::json!([{"command": "pilot"}])),
            JsonEditOptions::default(),
        );
        let parsed = parse_json_document(&inserted, JsonSyntax::Jsonc).unwrap();
        assert_eq!(parsed["hooks"]["PostToolUse"][0]["command"], "pilot");
        let removed = edit_jsonc(
            &inserted,
            &[JsonPathSeg::Key("hooks".into())],
            None,
            JsonEditOptions::default(),
        );
        let parsed = parse_json_document(&removed, JsonSyntax::Jsonc).unwrap();
        assert!(parsed.get("hooks").is_none() || parsed["hooks"].is_null());
    }
}
