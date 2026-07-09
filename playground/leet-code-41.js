/**
 * LeetCode 41: First Missing Positive
 * 
 * Given an unsorted integer array nums, return the smallest missing positive integer.
 * Implement a solution with O(n) time complexity and O(1) space complexity.
 * 
 * @param {number[]} nums - Unsorted array of integers
 * @return {number} - The smallest missing positive integer
 */
function firstMissingPositive(nums) {
    const n = nums.length;
    
    // Step 1: Replace non-positive numbers and numbers > n with n+1
    // This ensures all numbers are in range [1, n+1]
    for (let i = 0; i < n; i++) {
        if (nums[i] <= 0 || nums[i] > n) {
            nums[i] = n + 1;
        }
    }
    
    // Step 2: Mark presence of numbers in range [1, n]
    // Use index i to mark that number (i+1) is present
    for (let i = 0; i < n; i++) {
        const num = Math.abs(nums[i]);
        if (num >= 1 && num <= n) {
            // Mark as visited by making the value at index (num-1) negative
            const idx = num - 1;
            if (nums[idx] > 0) {
                nums[idx] = -nums[idx];
            }
        }
    }
    
    // Step 3: Find the first positive number's index
    // The first positive value at index i means number (i+1) is missing
    for (let i = 0; i < n; i++) {
        if (nums[i] > 0) {
            return i + 1;
        }
    }
    
    // If all positions 1 to n are present, return n+1
    return n + 1;
}

// Test cases
console.log(firstMissingPositive([1,2,0]));
// Expected: 3

console.log(firstMissingPositive([3,4,-1,1]));
// Expected: 2

console.log(firstMissingPositive([7,8,9,11,12]));
// Expected: 1

console.log(firstMissingPositive([1,1,2,2,3]));
// Expected: 4

console.log(firstMissingPositive([2,3,4]));
// Expected: 1

console.log(firstMissingPositive([1]));
// Expected: 2

// Export for testing
module.exports = firstMissingPositive;
