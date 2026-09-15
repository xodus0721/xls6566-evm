// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title WadMath
/// @notice Minimal 18-decimal (WAD) fixed-point math with full-precision mulDiv.
/// @dev Self-contained: no external dependencies, so the amortization math can be
///      unit- and fuzz-tested in isolation. `mulDiv` is the well-known
///      Remco Bloemen / OpenZeppelin 512-bit implementation, which computes
///      floor(a * b / denominator) without intermediate overflow.
library WadMath {
    /// @notice 1.0 in WAD fixed-point.
    uint256 internal constant WAD = 1e18;

    error MathOverflow();
    error DivByZero();

    /// @notice floor(a * b / WAD)
    function wmul(uint256 a, uint256 b) internal pure returns (uint256) {
        return mulDiv(a, b, WAD);
    }

    /// @notice floor(a * WAD / b)
    function wdiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return mulDiv(a, WAD, b);
    }

    /// @notice WAD-precision exponentiation with an INTEGER exponent, base in WAD.
    /// @dev Computes floor-ish (base/WAD)^n * WAD via exponentiation by squaring.
    ///      Only ~log2(n) multiplications, so rounding drift stays small.
    ///      `n == 0` returns WAD (i.e. 1.0), matching x^0 = 1.
    function wpow(uint256 base, uint256 n) internal pure returns (uint256 result) {
        result = WAD;
        while (n > 0) {
            if (n & 1 == 1) {
                result = wmul(result, base);
            }
            n >>= 1;
            if (n > 0) {
                base = wmul(base, base);
            }
        }
    }

    /// @notice Full-precision floor(a * b / denominator). Reverts on overflow of the
    ///         final result or when `denominator == 0`.
    function mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            // 512-bit multiply [prod1 prod0] = a * b.
            uint256 prod0; // least significant 256 bits
            uint256 prod1; // most significant 256 bits
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }

            // Handle the non-overflow case (product fits in 256 bits).
            if (prod1 == 0) {
                if (denominator == 0) revert DivByZero();
                return prod0 / denominator;
            }

            // The product overflowed 256 bits; require denominator > prod1
            // (equivalently, the final quotient fits in 256 bits).
            if (denominator <= prod1) revert MathOverflow();

            ///////////////////////////////////////////////
            // 512 by 256 division.
            ///////////////////////////////////////////////

            // Compute remainder using mulmod, then subtract it from [prod1 prod0].
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }

            // Factor out powers of two from the denominator.
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }

            // Shift bits from prod1 into prod0.
            prod0 |= prod1 * twos;

            // Invert denominator mod 2^256 via Newton-Raphson (denominator is odd).
            uint256 inverse = (3 * denominator) ^ 2;
            inverse *= 2 - denominator * inverse; // mod 2^8
            inverse *= 2 - denominator * inverse; // mod 2^16
            inverse *= 2 - denominator * inverse; // mod 2^32
            inverse *= 2 - denominator * inverse; // mod 2^64
            inverse *= 2 - denominator * inverse; // mod 2^128
            inverse *= 2 - denominator * inverse; // mod 2^256

            result = prod0 * inverse;
            return result;
        }
    }

    /// @notice Ceil variant: ceil(a * b / denominator).
    function mulDivUp(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        result = mulDiv(a, b, denominator);
        if (mulmod(a, b, denominator) > 0) {
            result += 1;
        }
    }
}
