/**
 * LeetCode 40: Combination Sum II
 * 
 * Given a collection of candidate numbers (candidates) and a target number (target),
 * find all unique combinations in candidates where the candidate numbers sum to target.
 * Each number in candidates may only be used once in the combination.
 * 
 * @param {number[]} candidates - Array of candidate numbers
 * @param {number} target - Target sum
 * @return {number[][]} - All unique combinations that sum to target
 */
function combinationSum2(candidates, target) {
    // Sort to handle duplicates and enable pruning
    candidates.sort((a, b) => a - b);
    
    const result = [];
    
    function backtrack(start, remaining, path) {
        // Base case: found a valid combination
        if (remaining === 0) {
            result.push([...path]);
            return;
        }
        
        // Base case: exceeded target, prune this branch
        if (remaining < 0) {
            return;
        }
        
        for (let i = start; i < candidates.length; i++) {
            // Skip duplicates at the same level
            if (i > start && candidates[i] === candidates[i - 1]) {
                continue;
            }
            
            // Prune if current number exceeds remaining
            if (candidates[i] > remaining) {
                break;
            }
            
            path.push(candidates[i]);
            backtrack(i + 1, remaining - candidates[i], path);
            path.pop();
        }
    }
    
    backtrack(0, target, []);
    
    return result;
}

// Test cases
console.log(combinationSum2([10,1,2,7,6,1,5], 8));
// Expected: [[1,1,6], [1,2,5], [1,7], [2,6]]

console.log(combinationSum2([2,5,2,1,2], 5));
// Expected: [[1,2,2], [5]]

// Export for testing
module.exports = combinationSum2;
