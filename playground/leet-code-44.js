/**
 * LeetCode 44: Wildcard Matching
 * 
 * Given an input string (s) and a pattern (p), implement wildcard pattern matching 
 * with support for '?' and '*':
 * - '?' Matches any single character
 * - '*' Matches any sequence of characters (including empty sequence)
 * 
 * The matching should cover the entire input string (not partial).
 * 
 * Constraints:
 * - s could be empty and contains only lowercase letters a-z
 * - p could be empty and contains only lowercase letters a-z, characters ? or *
 * 
 * @param {string} s - Input string
 * @param {string} p - Pattern string
 * @return {boolean} - Whether pattern matches the entire string
 */

// Dynamic Programming approach
function isMatch(s, p) {
    const m = s.length;
    const n = p.length;
    
    // dp[i][j] represents whether s[0..i-1] matches p[0..j-1]
    const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(false));
    
    // Empty string matches empty pattern
    dp[0][0] = true;
    
    // Handle patterns that can match empty string (e.g., *, **, ***, etc.)
    for (let j = 1; j <= n; j++) {
        if (p[j - 1] === '*') {
            dp[0][j] = dp[0][j - 1];
        }
    }
    
    // Fill the DP table
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            if (p[j - 1] === '*') {
                // '*' can either:
                // 1. Match empty sequence: dp[i][j-1]
                // 2. Match one or more characters: dp[i-1][j]
                dp[i][j] = dp[i][j - 1] || dp[i - 1][j];
            } else if (p[j - 1] === '?' || s[i - 1] === p[j - 1]) {
                // '?' matches any single char, or exact char match
                dp[i][j] = dp[i - 1][j - 1];
            }
            // else: characters don't match, dp[i][j] remains false
        }
    }
    
    return dp[m][n];
}

// Greedy approach (more efficient for large inputs)
function isMatchGreedy(s, p) {
    const m = s.length;
    const n = p.length;
    
    let i = 0; // pointer for s
    let j = 0; // pointer for p
    let starIndex = -1; // last '*' position in pattern
    let matchIndex = 0; // position in s when we last saw '*'
    
    while (i < m) {
        // Case 1: current chars match (exact or ?)
        if (j < n && (p[j] === s[i] || p[j] === '?')) {
            i++;
            j++;
        }
        // Case 2: current char in p is '*'
        else if (j < n && p[j] === '*') {
            starIndex = j;
            matchIndex = i;
            j++; // move past '*'
        }
        // Case 3: current chars don't match and we have seen '*' before
        else if (starIndex !== -1) {
            // backtrack: use '*' to match one more character
            j = starIndex + 1;
            matchIndex++;
            i = matchIndex;
        }
        // Case 4: no match and no '*' to backtrack to
        else {
            return false;
        }
    }
    
    // Check remaining pattern characters
    while (j < n && p[j] === '*') {
        j++;
    }
    
    return j === n;
}

// Test cases
console.log('Dynamic Programming approach:');
console.log(`isMatch("aa", "a") = ${isMatch("aa", "a")}`); // false
console.log(`isMatch("aa", "*") = ${isMatch("aa", "*")}`); // true
console.log(`isMatch("cb", "?a") = ${isMatch("cb", "?a")}`); // false
console.log(`isMatch("adceb", "*a*b") = ${isMatch("adceb", "*a*b")}`); // true
console.log(`isMatch("acdcb", "a*c?b") = ${isMatch("acdcb", "a*c?b")}`); // false

console.log('\nGreedy approach:');
console.log(`isMatchGreedy("aa", "a") = ${isMatchGreedy("aa", "a")}`);
console.log(`isMatchGreedy("aa", "*") = ${isMatchGreedy("aa", "*")}`);
console.log(`isMatchGreedy("cb", "?a") = ${isMatchGreedy("cb", "?a")}`);
console.log(`isMatchGreedy("adceb", "*a*b") = ${isMatchGreedy("adceb", "*a*b")}`);
console.log(`isMatchGreedy("acdcb", "a*c?b") = ${isMatchGreedy("acdcb", "a*c?b")}`);

// Performance test with large inputs
console.log('\nPerformance test (greedy vs DP):');
const largeS = 'a'.repeat(1000) + 'b';
const largeP = '*a*b';

console.time('Greedy');
isMatchGreedy(largeS, largeP);
console.timeEnd('Greedy');

console.time('DP');
isMatch(largeS, largeP);
console.timeEnd('DP');

module.exports = { isMatch, isMatchGreedy };
