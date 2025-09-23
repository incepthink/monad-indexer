import assert from "assert";
import { 
  TestHelpers,
  WMON_Approval
} from "generated";
const { MockDb, WMON } = TestHelpers;

describe("WMON contract Approval event tests", () => {
  // Create mock db
  const mockDb = MockDb.createMockDb();

  // Creating mock for WMON contract Approval event
  const event = WMON.Approval.createMockEvent({/* It mocks event fields with default values. You can overwrite them if you need */});

  it("WMON_Approval is created correctly", async () => {
    // Processing the event
    const mockDbUpdated = await WMON.Approval.processEvent({
      event,
      mockDb,
    });

    // Getting the actual entity from the mock database
    let actualWMONApproval = mockDbUpdated.entities.WMON_Approval.get(
      `${event.chainId}_${event.block.number}_${event.logIndex}`
    );

    // Creating the expected entity
    const expectedWMONApproval: WMON_Approval = {
      id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
      src: event.params.src,
      guy: event.params.guy,
      wad: event.params.wad,
    };
    // Asserting that the entity in the mock database is the same as the expected entity
    assert.deepEqual(actualWMONApproval, expectedWMONApproval, "Actual WMONApproval should be the same as the expectedWMONApproval");
  });
});
