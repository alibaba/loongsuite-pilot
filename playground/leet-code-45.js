/**
 * LeetCode 45: Jump Game II
 * 
 * Given an array of non-negative integers nums, where each element represents 
 * your maximum jump length at that position. You start at the first index.
 * 
 * Return the minimum number of jumps to reach the last index.
 * 
 * Constraints:
 * - You can jump from index i to any index i+1 to i+nums[i]
 * - 1 <= nums.length <= 10^4
 * - 0 <= nums[i] <= 1000
 * 
 * @param {number[]} nums - Array of maximum jump lengths
 * @return {number} - Minimum number of jumps to reach the last index
 */

// Greedy approach - O(n) time, O(1) space
function jump(nums) {
    const n = nums.length;
    if (n <= 1) return 0;
    
    let jumps = 0;      // Number of jumps made
    let currentEnd = 0; // Farthest index reachable with current number of jumps
    let farthest = 0;   // Farthest index we can reach from any position in current range
    
    // We only need to iterate to n-2 (second to last element)
    // because once we reach or pass n-1, we're done
    for (let i = 0; i < n - 1; i++) {
        // Update the farthest we can reach from position i
        farthest = Math.max(farthest, i + nums[i]);
        
        // When we reach the end of the current jump range
        if (i === currentEnd) {
            jumps++;
            currentEnd = farthest;
            
            // Early exit if we can already reach the end
            if (currentEnd >= n - 1) {
                return jumps;
            }
        }
    }
    
    return jumps;
}

// Dynamic Programming approach - O(n²) time, O(n) space
function jumpDP(nums) {
    const n = nums.length;
    
    // dp[i] = minimum jumps to reach index i
    const dp = Array(n).fill(Infinity);
    dp[0] = 0;
    
    for (let i = 1; i < n; i++) {
        // Check all previous positions
        for (let j = 0; j < i; j++) {
            // If we can jump from j to i
            if (j + nums[j] >= i) {
                dp[i] = Math.min(dp[i], dp[j] + 1);
            }
        }
    }
    
    return dp[n - 1];
}

// BFS approach - treats as shortest path in unweighted graph
function jumpBFS(nums) {
    const n = nums.length;
    if (n <= 1) return 0;
    
    let jumps = 0;
    let left = 0;  // Left boundary of current level
    let right = 0; // Right boundary of current level
    
    while (right < n - 1) {
        jumps++;
        
        // Find the farthest we can reach in this jump
        let nextRight = 0;
        for (let i = left; i <= right; i++) {
            nextRight = Math.max(nextRight, i + nums[i]);
        }
        
        left = right + 1;
        right = nextRight;
    }
    
    return jumps;
}

// Test cases
console.log('Greedy approach (O(n)):');
console.log(`jump([2,3,1,1,4]) = ${jump([2,3,1,1,4])}`); // 2
console.log(`jump([2,3,0,1,4]) = ${jump([2,3,0,1,4])}`); // 2
console.log(`jump([1]) = ${jump([1])}`); // 0
console.log(`jump([1,1,1,1]) = ${jump([1,1,1,1])}`); // 3
console.log(`jump([5,9,3,2,1,0,2,3,3,1,0,0]) = ${jump([5,9,3,2,1,0,2,3,3,1,0,0])}`); // 3

console.log('\nDP approach (O(n²)):');
console.log(`jumpDP([2,3,1,1,4]) = ${jumpDP([2,3,1,1,4])}`);
console.log(`jumpDP([2,3,0,1,4]) = ${jumpDP([2,3,0,1,4])}`);

console.log('\nBFS approach:');
console.log(`jumpBFS([2,3,1,1,4]) = ${jumpBFS([2,3,1,1,4])}`);
console.log(`jumpBFS([2,3,0,1,4]) = ${jumpBFS([2,3,0,1,4])}`);

// Performance comparison
console.log('\nPerformance comparison (large input):');
const largeNums = Array.from({ length: 1000 }, () => Math.floor(Math.random() * 100) + 1);
largeNums[0] = 100;

console.time('Greedy');
jump(largeNums);
console.timeEnd('Greedy');

console.time('DP');
jumpDP(largeNums);
console.timeEnd('DP');

console.time('BFS');
jumpBFS(largeNums);
console.timeEnd('BFS');

module.exports = { jump, jumpDP, jumpBFS };
