/**
 * LeetCode 42: Trapping Rain Water
 * 
 * Given n non-negative integers representing an elevation map,
 * compute how much water it can trap after raining.
 * 
 * @param {number[]} height - Array of non-negative integers representing elevation
 * @return {number} - Total units of trapped rain water
 */

// Approach 1: Two pointers (O(n) time, O(1) space) - Recommended
function trap(height) {
    if (height.length === 0) return 0;
    
    let left = 0, right = height.length - 1;
    let leftMax = 0, rightMax = 0;
    let water = 0;
    
    while (left < right) {
        // Water at any position depends on the lower of the two max heights
        if (height[left] < height[right]) {
            // Process left side
            if (height[left] >= leftMax) {
                leftMax = height[left];
            } else {
                water += leftMax - height[left];
            }
            left++;
        } else {
            // Process right side
            if (height[right] >= rightMax) {
                rightMax = height[right];
            } else {
                water += rightMax - height[right];
            }
            right--;
        }
    }
    
    return water;
}

// Alternative Approach 2: Prefix/Suffix Max (O(n) time, O(n) space)
function trapWithExtraSpace(height) {
    const n = height.length;
    if (n === 0) return 0;
    
    // leftMax[i] = max height from 0 to i
    const leftMax = new Array(n).fill(0);
    leftMax[0] = height[0];
    
    // rightMax[i] = max height from i to n-1
    const rightMax = new Array(n).fill(0);
    rightMax[n - 1] = height[n - 1];
    
    for (let i = 1; i < n; i++) {
        leftMax[i] = Math.max(leftMax[i - 1], height[i]);
    }
    
    for (let i = n - 2; i >= 0; i--) {
        rightMax[i] = Math.max(rightMax[i + 1], height[i]);
    }
    
    let water = 0;
    for (let i = 0; i < n; i++) {
        water += Math.min(leftMax[i], rightMax[i]) - height[i];
    }
    
    return water;
}

// Test cases
console.log(trap([0,1,0,2,1,0,1,3,2,1,2,1]));
// Expected: 6

console.log(trap([4,2,0,3,2,5]));
// Expected: 9

console.log(trap([1,2,3,4,5]));
// Expected: 0

console.log(trap([5,4,3,2,1]));
// Expected: 0

console.log(trap([3,1,2,1,3]));
// Expected: 4

// Export for testing
module.exports = trap;
