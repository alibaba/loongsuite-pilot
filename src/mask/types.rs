//! Mask-plan types that are not the shared config enums.
//!
//! `MaskType`, `MaskMode`, `MaskConfig`, and `MaskReplacementMode` live in
//! `crate::types` and are re-exported here. The structs below are the
//! rule-manifest and scan types from `src/mask/types.ts`.

use std::str::FromStr;

pub use crate::types::{
    MaskConfig, MaskMode, MaskReplacementMode, MaskType, PiiMaskType, PII_MASK_TYPES,
    SUPPORTED_MASK_TYPES,
};

use fancy_regex::Regex;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaskRuleKind {
    Regex,
    Block,
    UrlWithPassword,
}

impl MaskRuleKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Regex => "regex",
            Self::Block => "block",
            Self::UrlWithPassword => "urlWithPassword",
        }
    }
}

impl FromStr for MaskRuleKind {
    type Err = ();

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "regex" => Ok(Self::Regex),
            "block" => Ok(Self::Block),
            "urlWithPassword" => Ok(Self::UrlWithPassword),
            _ => Err(()),
        }
    }
}

/// Ordered unique mask types. Iteration follows insertion order, matching a JS `Set`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct MaskTypeSet {
    types: Vec<MaskType>,
}

impl MaskTypeSet {
    pub fn insert(&mut self, ty: MaskType) {
        if !self.types.contains(&ty) {
            self.types.push(ty);
        }
    }

    pub fn contains(&self, ty: MaskType) -> bool {
        self.types.contains(&ty)
    }

    pub fn iter(&self) -> impl Iterator<Item = MaskType> + '_ {
        self.types.iter().copied()
    }

    pub fn len(&self) -> usize {
        self.types.len()
    }

    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct CompiledMaskRule {
    pub id: String,
    pub mask_type: MaskType,
    pub kind: MaskRuleKind,
    pub replacement: String,
    pub prefilter: Vec<String>,
    pub pattern: Option<String>,
    pub flags: Option<String>,
    pub begin_pattern: Option<String>,
    pub end_pattern: Option<String>,
    pub schemes: Option<Vec<String>>,
    pub regex: Option<Regex>,
    pub block_regex: Option<Regex>,
    pub scheme_set: Option<HashSet<String>>,
    pub normalized_prefilter: Vec<String>,
}

impl CompiledMaskRule {
    pub(crate) fn has_prefilter(&self, normalized: &str) -> bool {
        self.normalized_prefilter
            .iter()
            .any(|keyword| normalized.contains(keyword))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MaskRange {
    pub start: usize,
    pub end: usize,
    pub replacement: String,
    pub rule_id: String,
    pub mask_type: MaskType,
}

#[derive(Debug, Clone)]
pub struct MaskPlan {
    pub rules: Vec<CompiledMaskRule>,
    pub pii_types: MaskTypeSet,
    pub replacement_mode: MaskReplacementMode,
}

impl MaskPlan {
    pub fn from_rules(rules: &[CompiledMaskRule]) -> Self {
        Self {
            rules: rules.to_vec(),
            pii_types: MaskTypeSet::default(),
            replacement_mode: MaskReplacementMode::Placeholder,
        }
    }
}

/// Either a full plan or a manifest-rule slice.
///
/// Passing only rules matches the TypeScript `MaskPlan | readonly CompiledMaskRule[]`
/// overload: PII detectors stay off and replacement mode is `placeholder`.
#[derive(Debug, Clone, Copy)]
pub enum PlanOrRules<'a> {
    Plan(&'a MaskPlan),
    Rules(&'a [CompiledMaskRule]),
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StringMaskOptions {
    pub large_string_threshold_bytes: Option<usize>,
    pub keyword_context_window: Option<usize>,
    pub private_key_block_limit: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedStringMaskOptions {
    pub large_string_threshold_bytes: usize,
    pub keyword_context_window: usize,
    pub private_key_block_limit: usize,
}

pub const DEFAULT_STRING_MASK_OPTIONS: ResolvedStringMaskOptions = ResolvedStringMaskOptions {
    large_string_threshold_bytes: 64 * 1024,
    keyword_context_window: 8 * 1024,
    private_key_block_limit: 64 * 1024,
};

pub const MASKED_TOKEN_PATTERN: &str = r"^\[(?:ACCESSKEY(?:_SECRET)?|APIKEY|PRIVATEKEY|DATABASEURL|IDCARD|PHONE|EMAIL|IP_ADDRESS|CREDIT_CARD)_MASKED\]$";

pub const MASKED_PREVIEW_TOKEN_PATTERN: &str = r"\[(?:ACCESSKEY(?:_SECRET)?|APIKEY|PRIVATEKEY|DATABASEURL|IDCARD|PHONE|EMAIL|IP_ADDRESS|CREDIT_CARD)_MASKED\]\{(?=[^{}\r\n]{0,511}\*)[^{}\r\n]{1,512}\}";

pub(crate) fn code_at(s: &str, index: usize) -> i32 {
    if index >= s.len() || !s.is_char_boundary(index) {
        return -1;
    }
    s[index..].chars().next().map(|ch| ch as i32).unwrap_or(-1)
}

pub(crate) fn char_len_at(s: &str, index: usize) -> usize {
    if index >= s.len() || !s.is_char_boundary(index) {
        return 0;
    }
    s[index..]
        .chars()
        .next()
        .map(|ch| ch.len_utf8())
        .unwrap_or(0)
}

pub(crate) fn prev_char(s: &str, index: usize) -> Option<(usize, i32)> {
    if index == 0 || index > s.len() {
        return None;
    }
    let mut prev = index - 1;
    while prev > 0 && !s.is_char_boundary(prev) {
        prev -= 1;
    }
    let code = s[prev..].chars().next()? as i32;
    Some((prev, code))
}

pub(crate) fn floor_char_boundary(s: &str, mut index: usize) -> usize {
    if index > s.len() {
        index = s.len();
    }
    while index > 0 && !s.is_char_boundary(index) {
        index -= 1;
    }
    index
}

pub(crate) fn ceil_char_boundary(s: &str, mut index: usize) -> usize {
    if index > s.len() {
        index = s.len();
    }
    while index < s.len() && !s.is_char_boundary(index) {
        index += 1;
    }
    index
}
