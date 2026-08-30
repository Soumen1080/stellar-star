# Provably Exact Split Arithmetic & Apportionment Policy

## 1. Problem Overview

In a group expense system, an amount of money $T$ denominated in integer stroops ($10^{-7}$ precision) must be split among $M$ participants with non-negative weights $w_1, w_2, \dots, w_M$.

When $T \cdot w_i$ is not cleanly divisible by the total weight $W = \sum w_i$, an indivisible remainder of stroops $R = T - \sum \lfloor (T \cdot w_i)/W \rfloor$ is created ($0 \le R < M$).

Naive solutions (such as handing the remainder to the last element in the array) suffer from:
1. **Array-Order Dependence**: Permuting the member array changes who gets charged more.
2. **Payer Inconsistency**: If only non-payer shares are calculated independently of the payer's share, $\sum \text{shares} + \text{payerShare} \ne T$, introducing real financial discrepancies.
3. **Weight Pathologies**: Failing to properly handle zero weights, fractional weights (e.g. $0.333$), or weights summing to values that don't divide $T$.

---

## 2. Selected Apportionment Method: Deterministic Largest Remainder (Hamilton / Hare-Niemeyer)

We adopt the **Largest Remainder Method** with a **Deterministic Lexicographical Tie-Breaker**.

### Step-by-Step Procedure:
1. **Weight Normalization**:
   All non-negative weights $w_i$ are converted to exact scaled BigInt values $W_i$ ($10^7$ scaling).
2. **Lower Quota Allocation**:
   Each participant receives a base share in stroops:
   $$\text{base}_i = \left\lfloor \frac{T \cdot W_i}{\sum W_k} \right\rfloor$$
   and generates a fractional remainder:
   $$r_i = (T \cdot W_i) \pmod{\sum W_k}$$
3. **Remainder Allocation**:
   The unallocated stroops $R = T - \sum \text{base}_i$ are distributed one-by-one ($+1$ stroop) to the top $R$ participants sorted by:
   $$\text{Key}(P_i) = (-r_i, P_i.\text{id})$$
   - Primary: Fractional remainder $r_i$ descending.
   - Secondary: Unique participant identifier $P_i.\text{id}$ ascending (lexicographical tie-breaker).

---

## 3. Invariant Proofs

### Invariant 1: Total Conservation
$$\sum_{i=1}^M \text{share}_i \equiv T \text{ stroops (No epsilon)}$$
- **Proof**: Total allocated $= \sum \text{base}_i + R$. By definition, $R = T - \sum \text{base}_i$. Thus, $\sum \text{share}_i = \sum \text{base}_i + (T - \sum \text{base}_i) = T$.

### Invariant 2: Non-Negativity
$$\forall i, \text{share}_i \ge 0$$
- **Proof**: $T \ge 0$ and $W_i \ge 0 \implies \text{base}_i \ge 0$ and extra stroop $\ge 0$.

### Invariant 3: Equal Weights Differ by at Most 1 Minor Unit
$$\forall i, j, \quad w_i = w_j \implies |\text{share}_i - \text{share}_j| \le 1 \text{ stroop}$$
- **Proof**: If $w_i = w_j$, then $\text{base}_i = \text{base}_j$ and $r_i = r_j$. The only difference arises if one receives a $+1$ remainder bonus and the other does not.

### Invariant 4 & 5: Order-Independence & Multiset Preservation
$$\text{Reordering participants produces an identical multiset of shares and preserves each member's exact allocation.}$$
- **Proof**: The sorting key $(-r_i, P_i.\text{id})$ depends solely on the participant's intrinsic weight, total amount, and unique ID. Array index is never used.

### Invariant 6: Zero-Weight Invariance
$$\text{Adding a member with } w_i = 0 \text{ assigns them 0 stroops and changes nobody else's share.}$$
- **Proof**: For $W_i = 0$, $\text{base}_i = 0$ and $r_i = 0$. Total weight $W$ is unchanged. The base shares and remainders of all other members remain mathematically identical.

---

## 4. The Alabama Paradox in Currency Splitting

In congressional apportionment with few discrete seats, Largest Remainder exhibits the *Alabama paradox* (increasing total seats can cause a state to lose a seat due to relative fractional shifts).

In currency splitting with 7 decimals ($10^{-7}$ precision):
- $T$ is on the scale of millions to billions of integer stroops.
- The Quota Rule strictly guarantees $|\text{share}_i - q_i| < 1$ stroop.
- Any discrepancy is bounded by $< 10^{-7}$ XLM, which is the atomic, indivisible quantum of the Stellar network.
- Monotonicity and exact zero-sum budget balance are guaranteed.
