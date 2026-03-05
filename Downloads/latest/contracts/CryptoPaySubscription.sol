// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transferFrom(address sender, address recipient, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

interface IERC20Permit {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

contract CryptoPaySubscription {
    struct Subscription {
        address sender;
        address receiver;
        address token;
        uint256 amount;
        uint256 interval;
        uint256 nextPaymentTime;
        bool active;
        uint256 totalPaid;
        uint256 paymentCount;
    }

    mapping(uint256 => Subscription) public subscriptions;
    uint256 public nextSubscriptionId;
    address public owner;
    bool private _entered;

    event SubscriptionCreated(
        uint256 indexed subscriptionId,
        address indexed sender,
        address indexed receiver,
        address token,
        uint256 amount,
        uint256 interval
    );

    event PaymentExecuted(
        uint256 indexed subscriptionId,
        address indexed sender,
        address indexed receiver,
        uint256 amount,
        uint256 timestamp
    );

    event SubscriptionCancelled(uint256 indexed subscriptionId);
    event SubscriptionUpdated(uint256 indexed subscriptionId, uint256 newAmount, uint256 newInterval);
    event ReceiverUpdated(uint256 indexed subscriptionId, address indexed oldReceiver, address indexed newReceiver);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    modifier nonReentrant() {
        require(!_entered, "Reentrancy");
        _entered = true;
        _;
        _entered = false;
    }

    constructor() {
        owner = msg.sender;
    }

    function _safeTransferFrom(address _token, address _from, address _to, uint256 _amount) internal {
        (bool ok, bytes memory ret) = _token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, _from, _to, _amount)
        );
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))), "Transfer failed");
    }

    // Single on-chain tx activation (requires allowance already set).
    // Transfers the user-chosen initialAmount to the receiver, then creates the recurring subscription
    // for recurringAmount every interval seconds. First recurring charge is due after the interval.
    function _activate(
        address _receiver,
        address _token,
        uint256 _initialAmount,
        uint256 _recurringAmount,
        uint256 _interval
    ) internal returns (uint256) {
        require(_receiver != address(0), "Invalid receiver");
        require(_token != address(0), "Invalid token");
        require(_recurringAmount > 0, "Amount must be > 0");
        require(_interval > 0, "Interval must be > 0");
        require(_interval >= 60, "Interval too small");

        IERC20 token = IERC20(_token);
        uint256 allowanceAmount = token.allowance(msg.sender, address(this));
        // Initial transfer consumes allowance; ensure at least one recurring payment can still be executed after activation.
        require(allowanceAmount >= _initialAmount + _recurringAmount, "Insufficient allowance");
        require(token.balanceOf(msg.sender) >= _initialAmount, "Insufficient balance");

        if (_initialAmount > 0) {
            _safeTransferFrom(_token, msg.sender, _receiver, _initialAmount);
        }

        uint256 subId = nextSubscriptionId++;
        subscriptions[subId] = Subscription({
            sender: msg.sender,
            receiver: _receiver,
            token: _token,
            amount: _recurringAmount,
            interval: _interval,
            nextPaymentTime: block.timestamp + _interval,
            active: true,
            totalPaid: 0,
            paymentCount: 0
        });

        emit SubscriptionCreated(subId, msg.sender, _receiver, _token, _recurringAmount, _interval);
        return subId;
    }

    // Single on-chain tx activation (requires allowance already set).
    // Transfers the user-chosen initialAmount to the receiver, then creates the recurring subscription
    // for recurringAmount every interval seconds. First recurring charge is due after the interval.
    function activate(
        address _receiver,
        address _token,
        uint256 _initialAmount,
        uint256 _recurringAmount,
        uint256 _interval
    ) external nonReentrant returns (uint256) {
        return _activate(_receiver, _token, _initialAmount, _recurringAmount, _interval);
    }

    // Two-prompt activation: 1) permit signature, 2) this transaction.
    function activateWithPermit(
        address _receiver,
        address _token,
        uint256 _initialAmount,
        uint256 _recurringAmount,
        uint256 _interval,
        uint256 _permitValue,
        uint256 _permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256) {
        IERC20Permit(_token).permit(msg.sender, address(this), _permitValue, _permitDeadline, v, r, s);
        return _activate(_receiver, _token, _initialAmount, _recurringAmount, _interval);
    }

    function createSubscription(
        address _receiver,
        address _token,
        uint256 _amount,
        uint256 _interval
    ) external nonReentrant returns (uint256) {
        require(_receiver != address(0), "Invalid receiver");
        require(_token != address(0), "Invalid token");
        require(_amount > 0, "Amount must be > 0");
        require(_interval > 0, "Interval must be > 0");
        require(_interval >= 60, "Interval too small");

        IERC20 token = IERC20(_token);
        uint256 allowanceAmount = token.allowance(msg.sender, address(this));
        require(allowanceAmount >= _amount, "Insufficient allowance");

        uint256 subId = nextSubscriptionId++;
        subscriptions[subId] = Subscription({
            sender: msg.sender,
            receiver: _receiver,
            token: _token,
            amount: _amount,
            interval: _interval,
            // First recurring payment should be due after the interval.
            nextPaymentTime: block.timestamp + _interval,
            active: true,
            totalPaid: 0,
            paymentCount: 0
        });

        emit SubscriptionCreated(subId, msg.sender, _receiver, _token, _amount, _interval);
        return subId;
    }

    function executeSubscription(uint256 _subscriptionId) external nonReentrant {
        Subscription storage sub = subscriptions[_subscriptionId];
        require(sub.active, "Subscription not active");
        require(block.timestamp >= sub.nextPaymentTime, "Too early");

        IERC20 token = IERC20(sub.token);
        uint256 allowanceAmount = token.allowance(sub.sender, address(this));
        require(allowanceAmount >= sub.amount, "Insufficient allowance");
        require(token.balanceOf(sub.sender) >= sub.amount, "Insufficient balance");

        // Effects before interactions: if a token attempts reentrancy, the subscription is no longer due.
        uint256 elapsed = block.timestamp - sub.nextPaymentTime;
        uint256 periods = (elapsed / sub.interval) + 1;
        sub.nextPaymentTime = sub.nextPaymentTime + (periods * sub.interval);
        sub.totalPaid += sub.amount;
        sub.paymentCount += 1;

        _safeTransferFrom(sub.token, sub.sender, sub.receiver, sub.amount);

        emit PaymentExecuted(_subscriptionId, sub.sender, sub.receiver, sub.amount, block.timestamp);
    }

    function cancelSubscription(uint256 _subscriptionId) external {
        Subscription storage sub = subscriptions[_subscriptionId];
        require(msg.sender == sub.sender || msg.sender == sub.receiver, "Not authorized");
        require(sub.active, "Already cancelled");

        sub.active = false;
        emit SubscriptionCancelled(_subscriptionId);
    }

    function updateSubscription(uint256 _subscriptionId, uint256 _newAmount, uint256 _newInterval) external {
        Subscription storage sub = subscriptions[_subscriptionId];
        // Prevent receiver-controlled "price changes" that can drain a sender with unlimited allowance.
        require(msg.sender == sub.sender, "Only sender");
        require(sub.active, "Subscription not active");
        require(_newAmount > 0, "Amount must be > 0");
        require(_newInterval > 0, "Interval must be > 0");
        require(_newInterval >= 60, "Interval too small");

        sub.amount = _newAmount;
        sub.interval = _newInterval;
        emit SubscriptionUpdated(_subscriptionId, _newAmount, _newInterval);
    }

    function updateReceiver(uint256 _subscriptionId, address _newReceiver) external onlyOwner {
        Subscription storage sub = subscriptions[_subscriptionId];
        require(sub.active, "Subscription not active");
        require(_newReceiver != address(0), "Invalid receiver");
        require(_newReceiver != sub.receiver, "Same receiver");

        address oldReceiver = sub.receiver;
        sub.receiver = _newReceiver;
        emit ReceiverUpdated(_subscriptionId, oldReceiver, _newReceiver);
    }

    function getSubscription(uint256 _subscriptionId) external view returns (Subscription memory) {
        return subscriptions[_subscriptionId];
    }

    function isDue(uint256 _subscriptionId) external view returns (bool) {
        Subscription storage sub = subscriptions[_subscriptionId];
        return sub.active && block.timestamp >= sub.nextPaymentTime;
    }

    function hasEnoughAllowance(uint256 _subscriptionId) external view returns (bool) {
        Subscription storage sub = subscriptions[_subscriptionId];
        if (!sub.active) return false;
        IERC20 token = IERC20(sub.token);
        return token.allowance(sub.sender, address(this)) >= sub.amount;
    }
}
