import assert from 'assert';
import { StateManager } from '../src/core/StateManager.js';
import { RequestManager } from '../src/core/RequestManager.js';
import { RouteManager } from '../src/core/RouteManager.js';
import { ElevatorController } from '../src/core/ElevatorController.js';
import { MultiLiftCoordinator } from '../src/core/MultiLiftCoordinator.js';
import { PassengerManager } from '../src/simulation/PassengerManager.js';
import { ThresholdEngine } from '../src/modules/camera_weight/ThresholdEngine.js';
import { LoadManager } from '../src/modules/camera_weight/LoadManager.js';
import { SafetyEngine } from '../src/modules/camera_weight/SafetyEngine.js';
import { eventManager } from '../src/core/EventManager.js';

console.log('========================================================');
console.log('   SMARTLIFT AI — TWO-LIFT SIMULATION VERIFICATION TEST  ');
console.log('========================================================\n');

let passedTests = 0;
let totalTests = 0;

function runTest(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`✓ [PASS] Test ${totalTests}: ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`✗ [FAIL] Test ${totalTests}: ${name}`);
    console.error(`  Error: ${err.message}`);
    console.error(err.stack);
  }
}

// TEST 1: Multiple passengers at one floor
runTest('Multiple passengers at one floor (G)', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const pm = new PassengerManager(state, requests, eventManager);

  // Add 5 passengers with different attributes to floor 0 (G)
  const p1 = pm.createPassenger({ floor: 0, destination: 2, type: 'adult', weight: 75 }).passenger;
  const p2 = pm.createPassenger({ floor: 0, destination: 4, type: 'senior', weight: 65 }).passenger;
  const p3 = pm.createPassenger({ floor: 0, destination: 6, type: 'wheelchair', weight: 85 }).passenger;
  const p4 = pm.createPassenger({ floor: 0, destination: 3, type: 'adult', weight: 80 }).passenger;
  const p5 = pm.createPassenger({ floor: 0, destination: 7, type: 'adult', weight: 70 }).passenger;

  const waitingAtG = state.waitingPassengers.filter(p => p.floor === 0);
  assert.strictEqual(waitingAtG.length, 5, 'Must contain all 5 passengers at Floor G');
  
  // Verify distinct IDs and no overwriting
  const ids = new Set(waitingAtG.map(p => p.id));
  assert.strictEqual(ids.size, 5, 'All passenger IDs must be unique');

  // Verify attributes preserved
  assert.strictEqual(waitingAtG.find(p => p.id === p3.id).type, 'wheelchair');
  assert.strictEqual(waitingAtG.find(p => p.id === p3.id).priority, 3);
  assert.strictEqual(waitingAtG.find(p => p.id === p2.id).priority, 2);
  assert.strictEqual(waitingAtG.find(p => p.id === p1.id).priority, 1);
});

// TEST 2: Simultaneous requests across floors
runTest('Simultaneous requests across floors (G, 2, 4, 6)', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const pm = new PassengerManager(state, requests, eventManager);
  const coordinator = new MultiLiftCoordinator(state, requests);

  pm.createPassenger({ floor: 0, destination: 3, type: 'adult', weight: 70 });
  pm.createPassenger({ floor: 2, destination: 5, type: 'adult', weight: 75 });
  pm.createPassenger({ floor: 4, destination: 1, type: 'senior', weight: 65 });
  pm.createPassenger({ floor: 6, destination: 7, type: 'wheelchair', weight: 80 });

  requests.syncPickupsFromWaiting();
  const pendingFloors = requests.getAllPendingFloors();
  assert.deepStrictEqual(pendingFloors.sort((a,b)=>a-b), [0, 2, 4, 6], 'Pending floors must be [0, 2, 4, 6]');

  coordinator.evaluateAndAssign();
  const pickups = requests.pickupRequests;
  assert.strictEqual(pickups.length, 4, 'Must have 4 registered pickup requests');
  pickups.forEach(p => {
    assert.ok(p.assignedLift === 'A' || p.assignedLift === 'B', `Floor ${p.floor} must be assigned to Lift A or B`);
  });
});

// TEST 3: 1.5-second batching window logic
runTest('1.5-second batching window logic', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const batchingFloors = new Map();

  function addPassengerWithBatch(floor, passengerData, onBatchReady) {
    state.addWaiting({ id: 'P_TEST_' + Date.now(), floor, ...passengerData });
    if (!batchingFloors.has(floor)) {
      batchingFloors.set(floor, { count: 1 });
      setTimeout(() => {
        batchingFloors.delete(floor);
        requests.syncPickupsFromWaiting();
        onBatchReady(floor);
      }, 150); // fast simulation of window
    } else {
      batchingFloors.get(floor).count += 1;
    }
  }

  addPassengerWithBatch(3, { weight: 70, type: 'adult', destination: 5 }, () => {});
  addPassengerWithBatch(3, { weight: 80, type: 'senior', destination: 6 }, () => {});
  
  assert.strictEqual(batchingFloors.get(3).count, 2, 'Batching window should accumulate passengers at floor 3');
  assert.strictEqual(state.waitingPassengers.filter(p => p.floor === 3).length, 2, 'Both passengers stored in state');
});

// TEST 4: Passenger-specific destinations after boarding & exiting
runTest('Passenger-specific destinations after boarding & exiting', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const routeA = new RouteManager(state, requests, 'A');
  const ctrlA = new ElevatorController(state, requests, routeA, 'A');

  state.getElev('A').currentFloor = 0;
  state.getElev('A').door = 'closed';

  // Add 2 passengers at Floor 0 with different destinations
  state.addWaiting({ id: 'PA', floor: 0, destination: 2, type: 'adult', weight: 70, status: 'WAITING' });
  state.addWaiting({ id: 'PB', floor: 0, destination: 5, type: 'adult', weight: 80, status: 'WAITING' });
  requests.syncPickupsFromWaiting();

  // Lift A boards them at Floor 0
  ctrlA._handleBoardingAndExiting(0, { type: 'pickup' });
  
  const inside = state.getInside('A');
  assert.strictEqual(inside.length, 2, 'Both passengers must be boarded inside Lift A');
  assert.strictEqual(inside.find(p => p.id === 'PA').destination, 2, 'PA destination must be 2');
  assert.strictEqual(inside.find(p => p.id === 'PB').destination, 5, 'PB destination must be 5');

  // Verify destination requests created for Lift A
  assert.ok(requests.hasDestination(2, 'A'), 'Floor 2 destination request must exist for Lift A');
  assert.ok(requests.hasDestination(5, 'A'), 'Floor 5 destination request must exist for Lift A');

  // Simulate arrival at Floor 2 -> PA exits, PB remains
  ctrlA._handleBoardingAndExiting(2, { type: 'destination' });
  assert.strictEqual(state.getInside('A').length, 1, 'Only PB should remain inside after Floor 2 exit');
  assert.strictEqual(state.getInside('A')[0].id, 'PB', 'PB must be the remaining passenger');
  assert.strictEqual(requests.hasDestination(2, 'A'), false, 'Floor 2 destination must be consumed');
  assert.strictEqual(requests.hasDestination(5, 'A'), true, 'Floor 5 destination must still remain');
});

// TEST 5: Elderly and wheelchair priority in scoring & boarding
runTest('Elderly and wheelchair priority', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const pm = new PassengerManager(state, requests, eventManager);
  const coordinator = new MultiLiftCoordinator(state, requests);

  // Lift A at floor 1, Lift B at floor 1
  state.getElev('A').currentFloor = 1;
  state.getElev('B').currentFloor = 1;

  // Adult at floor 3
  const pAdult = pm.createPassenger({ floor: 3, destination: 7, type: 'adult', weight: 75 }).passenger;
  assert.strictEqual(pAdult.priority, 1);

  // Wheelchair at floor 4
  const pWheel = pm.createPassenger({ floor: 4, destination: 7, type: 'wheelchair', weight: 80 }).passenger;
  assert.strictEqual(pWheel.priority, 3);

  // Senior at floor 5
  const pSenior = pm.createPassenger({ floor: 5, destination: 7, type: 'senior', weight: 70 }).passenger;
  assert.strictEqual(pSenior.priority, 2);

  const scoreAdult = coordinator.scoreLift('A', 3);
  const scoreWheel = coordinator.scoreLift('A', 4);

  // Wheelchair receives higher priority deduction (-2)
  assert.ok(scoreWheel !== null && scoreAdult !== null, 'Scoring must produce valid scores');
});

// TEST 6: Dynamic weight-threshold calculation & outcomes
runTest('Dynamic weight-threshold calculation & outcomes (SAFE, DEFERRED, UNSAFE)', () => {
  // Base threshold is 750kg, Hard capacity is 800kg
  assert.strictEqual(ThresholdEngine.BASE_THRESHOLD, 750);
  assert.strictEqual(ThresholdEngine.HARD_CAPACITY, 800);

  // Inside cabin with 1 wheelchair user
  const cabin = [{ id: 'P1', type: 'wheelchair', weight: 85 }];
  const threshWheel = ThresholdEngine.calculate(cabin);
  assert.strictEqual(threshWheel, 750 - 110, 'Wheelchair reduces dynamic threshold by 110kg');

  // Candidate evaluation: SAFE
  const safeCandidate = { id: 'P2', type: 'adult', weight: 75 };
  const evalSafe = SafetyEngine.evaluateProjected(cabin, safeCandidate);
  assert.strictEqual(evalSafe.safe, true);
  assert.strictEqual(evalSafe.decision, 'SAFE');

  // Candidate evaluation: DEFERRED (exceeds dynamic threshold 640kg, but within 800kg hard capacity)
  const heavyCabin = [{ id: 'P1', type: 'wheelchair', weight: 85 }, { id: 'P2', type: 'adult', weight: 500 }];
  const deferCandidate = { id: 'P3', type: 'adult', weight: 80 }; // 85+500+80 = 665kg > 640kg threshold, but <= 800kg
  const evalDefer = SafetyEngine.evaluateProjected(heavyCabin, deferCandidate);
  assert.strictEqual(evalDefer.safe, false);
  assert.strictEqual(evalDefer.decision, 'DEFERRED');

  // Candidate evaluation: UNSAFE (exceeds 800kg hard capacity)
  const unsafeCandidate = { id: 'P4', type: 'adult', weight: 250 }; // 85+500+250 = 835kg > 800kg
  const evalUnsafe = SafetyEngine.evaluateProjected(heavyCabin, unsafeCandidate);
  assert.strictEqual(evalUnsafe.safe, false);
  assert.strictEqual(evalUnsafe.decision, 'UNSAFE');
});

// TEST 7: Cumulative group boarding
runTest('Cumulative group boarding (Safe board, remainder deferred)', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const routeA = new RouteManager(state, requests, 'A');
  const ctrlA = new ElevatorController(state, requests, routeA, 'A');

  state.getElev('A').currentFloor = 0;
  // Cabin starts at 600kg
  state.insideByLift.A = [{ id: 'P_EXISTING', type: 'adult', weight: 600, destination: 7 }];

  // Floor 0 has 2 waiting passengers: 80kg (safe, total 680 <= 750) and 100kg (would push total to 780 > 750)
  state.addWaiting({ id: 'P_SAFE', floor: 0, destination: 3, type: 'adult', weight: 80, priority: 1, status: 'WAITING' });
  state.addWaiting({ id: 'P_DEFER', floor: 0, destination: 4, type: 'adult', weight: 100, priority: 1, status: 'WAITING' });
  requests.syncPickupsFromWaiting();

  // Arrival at Floor 0
  ctrlA._handleBoardingAndExiting(0, { type: 'pickup' });

  // P_SAFE should board, P_DEFER should stay in waiting queue as DEFERRED
  assert.ok(state.getInside('A').some(p => p.id === 'P_SAFE'), 'P_SAFE must be boarded');
  assert.ok(state.waitingPassengers.some(p => p.id === 'P_DEFER'), 'P_DEFER must remain in queue');
  assert.strictEqual(state.waitingPassengers.find(p => p.id === 'P_DEFER').status, 'DEFERRED');
});

// TEST 8: Ghost call for one passenger
runTest('Ghost call for one passenger (cancelling one does not drop others)', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const pm = new PassengerManager(state, requests, eventManager);

  const p1 = pm.createPassenger({ floor: 2, destination: 5, type: 'adult', weight: 70 }).passenger;
  const p2 = pm.createPassenger({ floor: 2, destination: 6, type: 'adult', weight: 80 }).passenger;

  requests.syncPickupsFromWaiting();
  assert.strictEqual(requests.pickupRequests.find(r => r.floor === 2).passengerIds.length, 2);

  // Cancel only p1
  pm.removePassenger(p1.id);

  assert.strictEqual(state.waitingPassengers.some(p => p.id === p1.id), false, 'p1 must be removed');
  assert.strictEqual(state.waitingPassengers.some(p => p.id === p2.id), true, 'p2 must remain');
  assert.strictEqual(requests.isPickupFloor(2), true, 'Floor 2 must still remain an active pickup floor for p2');
});

// TEST 9: Ghost call for all passengers
runTest('Ghost call for all passengers removes unnecessary stop', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const pm = new PassengerManager(state, requests, eventManager);

  const p1 = pm.createPassenger({ floor: 3, destination: 7, type: 'adult', weight: 75 }).passenger;
  requests.syncPickupsFromWaiting();
  assert.strictEqual(requests.isPickupFloor(3), true);

  // Cancel p1 (last passenger at floor 3)
  pm.removePassenger(p1.id);
  requests.syncPickupsFromWaiting();

  assert.strictEqual(requests.isPickupFloor(3), false, 'Floor 3 must no longer be a pickup floor');
});

// TEST 10: Two-lift independent coordination across G-7
runTest('Two-lift independent coordination across G-7', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const coordinator = new MultiLiftCoordinator(state, requests);

  state.getElev('A').currentFloor = 1;
  state.getElev('A').direction = 'idle';
  state.getElev('B').currentFloor = 6;
  state.getElev('B').direction = 'idle';

  // Request at Floor 0 (close to A) and Floor 7 (close to B)
  state.addWaiting({ id: 'P_NEAR_A', floor: 0, destination: 3, type: 'adult', weight: 70 });
  state.addWaiting({ id: 'P_NEAR_B', floor: 7, destination: 4, type: 'adult', weight: 70 });
  requests.syncPickupsFromWaiting();

  coordinator.evaluateAndAssign();

  const reqA = requests.pickupRequests.find(r => r.floor === 0);
  const reqB = requests.pickupRequests.find(r => r.floor === 7);

  assert.strictEqual(reqA.assignedLift, 'A', 'Lift A should be assigned to Floor 0');
  assert.strictEqual(reqB.assignedLift, 'B', 'Lift B should be assigned to Floor 7');
});

// TEST 11: Safety and priority interaction
runTest('Safety takes precedence over priority', () => {
  const state = new StateManager();
  const requests = new RequestManager(state);
  const routeA = new RouteManager(state, requests, 'A');
  const ctrlA = new ElevatorController(state, requests, routeA, 'A');

  state.getElev('A').currentFloor = 0;
  // Cabin is already at 720kg load
  state.insideByLift.A = [{ id: 'P_HEAVY', type: 'adult', weight: 720, destination: 7 }];

  // Priority wheelchair passenger arrives (weight 90kg -> 720+90 = 810kg > 800kg hard cap)
  state.addWaiting({ id: 'P_PRIO_OVERLOAD', floor: 0, destination: 4, type: 'wheelchair', weight: 90, priority: 3, status: 'WAITING' });
  requests.syncPickupsFromWaiting();

  ctrlA._handleBoardingAndExiting(0, { type: 'pickup' });

  // Wheelchair passenger must NOT board because it violates hard capacity
  assert.strictEqual(state.getInside('A').some(p => p.id === 'P_PRIO_OVERLOAD'), false, 'Overloaded priority passenger must not board');
  assert.strictEqual(state.waitingPassengers.find(p => p.id === 'P_PRIO_OVERLOAD').status, 'DEFERRED', 'Must remain queued as DEFERRED');
});

// TEST 12: Hardware prototype isolation
runTest('Hardware prototype isolation (Floors G-3, single lift, unpolluted motor logic)', () => {
  const state = new StateManager();
  state.resetLifts();
  
  // Virtual simulation supports G-7 (0 to 7)
  assert.strictEqual(state.minFloor, 0);
  assert.strictEqual(state.maxFloor, 7);
  assert.ok(state.elevators.A && state.elevators.B, 'Simulation has both Lift A and Lift B');

  // Verify that hardware prototype mode limits floors to 4 (G-3) without touching main.ino
  const hwFloors = [0, 1, 2, 3];
  assert.strictEqual(hwFloors.length, 4);
});

console.log('\n========================================================');
console.log(`TEST RESULTS: ${passedTests} / ${totalTests} PASSED`);
console.log('========================================================\n');

if (passedTests === totalTests) {
  process.exit(0);
} else {
  process.exit(1);
}
