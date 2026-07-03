const fs = require('fs');
const path = require('path');
const { LuaFactory } = require('wasmoon');
const assert = require('assert');

// Helper to load file content and preprocess if necessary
function getScriptContent(filename) {
  const filePath = path.join(__dirname, '../scripts', filename);
  let content = fs.readFileSync(filePath, 'utf8');
  // Preprocess: Replace unpack(arg) with ... for Lua 5.4 compatibility
  content = content.replace(/unpack\(\s*arg\s*\)/g, '...');
  return content;
}

async function runAllTests() {
  console.log('--- Setting up Lua VM & Mock Environment ---');
  const factory = new LuaFactory();
  const lua = await factory.createEngine();

  // Load the FG Mock environment in Lua
  await lua.doString(`
    -- Mocks for Fantasy Grounds globals
    Session = { IsHost = true }

    DataCommon = {
        creaturesize = {
            fine = -4,
            diminutive = -3,
            tiny = -2,
            small = -1,
            medium = 0,
            large = 1,
            huge = 2,
            gargantuan = 3,
            colossal = 4
        }
    }

    GameSystem = {
        GameSystem = {
            getDistanceUnitsPerGrid = function()
                return 5
            end
        }
    }

    -- DB Mock implementation
    DB = {}
    DB._nodes = {}
    DB._values = {}
    DB._handlers = {}

    function DB.createNode(path, parent)
        if DB._nodes[path] then return DB._nodes[path] end
        local node = {}
        node.path = path
        node.parent = parent
        
        function node.getPath() return path end
        function node.getParent() return parent end
        function node.getName()
            local name = path:match("([^.]+)$")
            return name
        end
        function node.getChild(childName)
            return DB.createNode(path .. "." .. childName, node)
        end
        function node.deleteChild(childName)
            DB.deleteChild(node, childName)
        end
        function node.getValue(childName, defaultValue)
            return DB.getValue(node, childName, defaultValue)
        end
        function node.setValue(childName, sType, value)
            DB.setValue(node, childName, sType, value)
        end

        DB._nodes[path] = node
        return node
    end

    function DB.getValue(vNode, sSubPath, vDefault)
        local path
        if type(vNode) == "string" then
            path = vNode
        elseif type(vNode) == "table" and vNode.getPath then
            path = vNode.getPath()
        else
            return vDefault
        end
        
        if sSubPath and sSubPath ~= "" then
            path = path .. "." .. sSubPath
        end
        
        local val = DB._values[path]
        if val == nil then return vDefault end
        return val
    end

    function DB.setValue(vNode, sSubPath, sType, vValue)
        local path
        if type(vNode) == "string" then
            path = vNode
        elseif type(vNode) == "table" and vNode.getPath then
            path = vNode.getPath()
        else
            error("Invalid vNode in DB.setValue")
        end
        
        if sSubPath and sSubPath ~= "" then
            path = path .. "." .. sSubPath
        end
        
        DB._values[path] = vValue
        
        -- Ensure node and parent node exist
        local node = DB._nodes[path]
        if not node then
            local nodeName = path:match("([^.]+)$")
            local parentPath = path:sub(1, #path - #nodeName - 1)
            local parentNode
            if parentPath ~= "" then
                parentNode = DB.createNode(parentPath)
            end
            node = DB.createNode(path, parentNode)
        end
        
        -- Trigger onUpdate on the node itself
        DB.triggerHandlers(path, "onUpdate", node)
        -- Bubble up onChildUpdate to all ancestors
        local parent = node.getParent()
        while parent do
            DB.triggerHandlers(parent.getPath(), "onChildUpdate", node)
            parent = parent.getParent()
        end
    end

    function DB.deleteChild(vNode, sSubPath)
        local path
        if type(vNode) == "string" then
            path = vNode
        elseif type(vNode) == "table" and vNode.getPath then
            path = vNode.getPath()
        else
            error("Invalid vNode in DB.deleteChild")
        end
        
        if sSubPath and sSubPath ~= "" then
            path = path .. "." .. sSubPath
        end
        
        local node = DB._nodes[path]
        if node then
            DB._values[path] = nil
            DB._nodes[path] = nil
            
            DB.triggerHandlers(path, "onDelete", node)
            local parent = node.getParent()
            if parent then
                DB.triggerHandlers(parent.getPath(), "onChildDeleted", node)
            end
        end
    end

    function DB.addHandler(sPattern, sEvent, fCallback)
        if not DB._handlers[sEvent] then DB._handlers[sEvent] = {} end
        table.insert(DB._handlers[sEvent], { pattern = sPattern, callback = fCallback })
    end

    function DB.triggerHandlers(path, event, node)
        local list = DB._handlers[event]
        if not list then return end
        for _, item in ipairs(list) do
            local pattern = item.pattern:gsub("%.", "%%."):gsub("%*", "[^%.]+")
            if path:match("^" .. pattern .. "$") or path == item.pattern then
                item.callback(node)
            end
        end
    end

    -- Other Mocks
    ActorManager = {}
    ActorManager._actorTypes = {}
    ActorManager._actorChars = {}

    function ActorManager.getCTNode(rActor)
        if type(rActor) == "table" then
            if rActor.getPath then return rActor end
            if rActor.sCTNode then return DB.createNode(rActor.sCTNode) end
            return rActor.nodeCT
        elseif type(rActor) == "string" then
            return DB.createNode(rActor)
        end
        return rActor
    end

    function ActorManager.getTypeAndNode(nodeCombatant)
        local path = nodeCombatant.getPath()
        local sType = ActorManager._actorTypes[path] or "pc"
        local nodeChar = ActorManager._actorChars[path] or nodeCombatant
        return sType, nodeChar
    end

    ActorManager5E = {}
    function ActorManager5E.isSize(rActor, sSizeCheck)
        local nodeCT = ActorManager.getCTNode(rActor)
        local size = DB.getValue(nodeCT, "size", ""):lower()
        return size == sSizeCheck:lower()
    end

    CharEncumbranceManager5E = {}
    CharEncumbranceManager5E.updateLimitCalled = {}
    function CharEncumbranceManager5E.getEncumbranceMult(nodeChar)
        local sSize = DB.getValue(nodeChar, "size", ""):lower()
        if sSize == "large" then return 2
        elseif sSize == "huge" then return 4
        elseif sSize == "gargantuan" then return 8
        elseif sSize == "tiny" then return 0.5
        else return 1 end
    end

    function CharEncumbranceManager5E.updateEncumbranceLimit(nodeChar)
        local path = nodeChar.getPath()
        CharEncumbranceManager5E.updateLimitCalled[path] = (CharEncumbranceManager5E.updateLimitCalled[path] or 0) + 1
    end

    EffectManager = {}
    EffectManager._effects = {}
    function EffectManager.getEffectsByType(nodeCombatant, sEffectType)
        local path = nodeCombatant.getPath()
        local nodeEffects = EffectManager._effects[path]
        if not nodeEffects then return {} end
        return nodeEffects[sEffectType] or {}
    end

    TokenManager = {}
    TokenManager.updateSizeHelperCalled = 0
    TokenManager.autoTokenScaleCalled = 0
    TokenManager.tokenSpaces = {}

    function TokenManager.updateSizeHelper(tokenCT, nodeCT)
        TokenManager.updateSizeHelperCalled = TokenManager.updateSizeHelperCalled + 1
    end

    function TokenManager.autoTokenScale(tokenCT)
        TokenManager.autoTokenScaleCalled = TokenManager.autoTokenScaleCalled + 1
    end

    function TokenManager.getTokenSpace(tokenMap)
        return TokenManager.tokenSpaces[tokenMap] or 1
    end

    CombatManager = {}
    CombatManager.CT_COMBATANT_PATH = "combattracker.list.*"
    CombatManager._tokens = {}

    function CombatManager.getTokenFromCT(nodeCombatant)
        local path = nodeCombatant.getPath()
        return CombatManager._tokens[path]
    end

    OptionsManager = {}
    OptionsManager._options = {}
    function OptionsManager.getOption(sKey)
        return OptionsManager._options[sKey] or ""
    end

    unpack = table.unpack

    -- Environment loading helper
    function loadExtensionScript(packageName, fileContent, filePath)
        local pkg = {}
        setmetatable(pkg, { __index = _G })
        _G[packageName] = pkg
        
        local chunk, err = load(fileContent, filePath, "t", pkg)
        if not chunk then
            error("Error loading " .. filePath .. ": " .. tostring(err))
        end
        
        local success, runErr = pcall(chunk)
        if not success then
            error("Error running " .. filePath .. ": " .. tostring(runErr))
        end
    end
  `);

  // Load scripts into packages
  const scripts = [
    { name: 'ActorManagerSM', file: 'manager_actor_sm.lua' },
    { name: 'EncumbranceManagerSM', file: 'manager_encumbrance_sm.lua' },
    { name: 'SizeManager', file: 'manager_size.lua' },
    { name: 'TokenManagerSM', file: 'manager_token_sm.lua' }
  ];

  for (const script of scripts) {
    const content = getScriptContent(script.file);
    lua.global.set('temp_content', content);
    lua.global.set('temp_name', script.name);
    lua.global.set('temp_file', 'scripts/' + script.file);
    await lua.doString(`loadExtensionScript(temp_name, temp_content, temp_file)`);
  }

  // Run onInit on all packages in loading order
  await lua.doString(`
    ActorManagerSM.onInit()
    EncumbranceManagerSM.onInit()
    SizeManager.onInit()
    TokenManagerSM.onInit()
  `);

  console.log('--- Environment initialized successfully ---');

  let failedTests = 0;
  const test = (name, fn) => {
    try {
      fn();
      console.log(`[PASS] ${name}`);
    } catch (e) {
      console.error(`[FAIL] ${name}`);
      console.error(e);
      failedTests++;
    }
  };

  // Helper to clear DB state between tests
  const resetDB = async () => {
    await lua.doString(`
      DB._values = {}
      DB._nodes = {}
      EffectManager._effects = {}
      CharEncumbranceManager5E.updateLimitCalled = {}
      TokenManager.updateSizeHelperCalled = 0
      TokenManager.autoTokenScaleCalled = 0
      CombatManager._tokens = {}
      OptionsManager._options = {}
    `);
  };

  // --- ACTOR SIZE ADJUSTMENTS TESTS ---
  await resetDB();
  test('calculateSize: defaults to medium (0) when size is not set', async () => {
    await lua.doString(`
      nodeCT = DB.createNode("combattracker.list.id-00001")
    `);
    const size = await lua.doString(`return SizeManager.calculateSize(nodeCT)`);
    assert.strictEqual(size, 0);
  });

  test('calculateSize: reads base size correctly', async () => {
    await lua.doString(`
      DB.setValue("combattracker.list.id-00001.size", "string", "large")
      nodeCT = DB.createNode("combattracker.list.id-00001")
    `);
    const size = await lua.doString(`return SizeManager.calculateSize(nodeCT)`);
    assert.strictEqual(size, 1); // large = 1
  });

  test('calculateSize: applies modifier from SIZE effect', async () => {
    await lua.doString(`
      DB.setValue("combattracker.list.id-00001.size", "string", "medium")
      nodeCT = DB.createNode("combattracker.list.id-00001")
      EffectManager._effects["combattracker.list.id-00001"] = {
        SIZE = { { remainder = {}, mod = 1 } }
      }
    `);
    const size = await lua.doString(`return SizeManager.calculateSize(nodeCT)`);
    assert.strictEqual(size, 1); // medium (0) + 1 = 1 (large)
    const currentSize = await lua.doString(`return DB.getValue("combattracker.list.id-00001.currentsize")`);
    assert.strictEqual(currentSize, 'large');
  });

  test('calculateSize: overrides size via remainder from SIZE effect', async () => {
    await lua.doString(`
      DB.setValue("combattracker.list.id-00001.size", "string", "medium")
      nodeCT = DB.createNode("combattracker.list.id-00001")
      EffectManager._effects["combattracker.list.id-00001"] = {
        SIZE = { { remainder = {"huge"}, mod = 0 } }
      }
    `);
    const size = await lua.doString(`return SizeManager.calculateSize(nodeCT)`);
    assert.strictEqual(size, 2); // huge = 2
    const currentSize = await lua.doString(`return DB.getValue("combattracker.list.id-00001.currentsize")`);
    assert.strictEqual(currentSize, 'huge');
  });

  test('calculateSize: min and max size constraints', async () => {
    // colossal is 4. Modifier +1 would be 5, but should cap at 4 (colossal)
    await lua.doString(`
      DB.setValue("combattracker.list.id-00001.size", "string", "colossal")
      nodeCT = DB.createNode("combattracker.list.id-00001")
      EffectManager._effects["combattracker.list.id-00001"] = {
        SIZE = { { remainder = {}, mod = 1 } }
      }
    `);
    const sizeMax = await lua.doString(`return SizeManager.calculateSize(nodeCT)`);
    assert.strictEqual(sizeMax, 4);

    // fine is -4. Modifier -1 would be -5, but should cap at -4 (fine)
    await lua.doString(`
      DB.setValue("combattracker.list.id-00001.size", "string", "fine")
      nodeCT = DB.createNode("combattracker.list.id-00001")
      EffectManager._effects["combattracker.list.id-00001"] = {
        SIZE = { { remainder = {}, mod = -1 } }
      }
    `);
    const sizeMin = await lua.doString(`return SizeManager.calculateSize(nodeCT)`);
    assert.strictEqual(sizeMin, -4);
  });

  // --- TOKEN SPACE & SCALING TESTS ---
  await resetDB();
  test('calculateSpace: returns default space based on grid unit (5) for medium size', async () => {
    await lua.doString(`
      nodeCT = DB.createNode("combattracker.list.id-00001")
    `);
    const space = await lua.doString(`return SizeManager.calculateSpace(nodeCT)`);
    assert.strictEqual(space, 5);
  });

  test('calculateSpace: scales space automatically for large/huge size', async () => {
    // Large size should result in space = 10 (2 grids)
    await lua.doString(`
      DB.setValue("combattracker.list.id-00001.size", "string", "large")
      nodeCT = DB.createNode("combattracker.list.id-00001")
    `);
    await lua.doString(`SizeManager.calculateSpace(nodeCT)`);
    const currentSpace = await lua.doString(`return DB.getValue("combattracker.list.id-00001.currentspace")`);
    assert.strictEqual(currentSpace, 10);
  });

  test('calculateSpace: SPACE effect override and ADDSPACE modifier', async () => {
    await lua.doString(`
      nodeCT = DB.createNode("combattracker.list.id-00001")
      EffectManager._effects["combattracker.list.id-00001"] = {
        SPACE = { { remainder = {}, mod = 15 } },
        ADDSPACE = { { remainder = {}, mod = 5 } }
      }
    `);
    await lua.doString(`SizeManager.calculateSpace(nodeCT)`);
    const currentSpace = await lua.doString(`return DB.getValue("combattracker.list.id-00001.currentspace")`);
    assert.strictEqual(currentSpace, 20); // 15 + 5
  });

  // --- REACH TESTS ---
  await resetDB();
  test('calculateReach: handles base, REACH override, and ADDREACH modifiers', async () => {
    await lua.doString(`
      nodeCT = DB.createNode("combattracker.list.id-00001")
    `);
    const reachBase = await lua.doString(`return SizeManager.calculateReach(nodeCT)`);
    assert.strictEqual(reachBase, 5);

    await lua.doString(`
      EffectManager._effects["combattracker.list.id-00001"] = {
        REACH = { { remainder = {}, mod = 10 } },
        ADDREACH = { { remainder = {}, mod = 5 } }
      }
    `);
    await lua.doString(`SizeManager.calculateReach(nodeCT)`);
    const currentReach = await lua.doString(`return DB.getValue("combattracker.list.id-00001.currentreach")`);
    assert.strictEqual(currentReach, 15); // 10 + 5
  });

  // --- SWAPPING & MOCKED WRAPPERS TESTS ---
  await resetDB();
  test('getTokenSpace & updateSizeHelper: correctly swap space/reach state', async () => {
    // We mock the original getTokenSpace to return whether bShouldSwap was active
    await lua.doString(`
      function TokenManager.getTokenSpace(tokenMap)
          return SizeManager.bShouldSwap
      end
    `);
    const wasSwapped = await lua.doString(`return TokenManagerSM.getTokenSpace("some_token")`);
    // During getTokenSpace call, swapSpaceReach should be active
    assert.strictEqual(wasSwapped, true);
    // After call, resetSpaceReach should reset it
    const isSwappedAfter = await lua.doString(`return SizeManager.bShouldSwap`);
    assert.strictEqual(isSwappedAfter, false);
  });

  test('isSize: swaps and resets size state during check', async () => {
    await lua.doString(`
      function ActorManager5E.isSize(rActor, sSizeCheck)
          return SizeManager.bShouldSwap
      end
    `);
    const wasSwapped = await lua.doString(`return ActorManagerSM.isSize("actor_node", "large")`);
    assert.strictEqual(wasSwapped, true);
    const isSwappedAfter = await lua.doString(`return SizeManager.bShouldSwap`);
    assert.strictEqual(isSwappedAfter, false);
  });

  // --- ENCUMBRANCE MULTIPLIER TESTS ---
  await resetDB();
  test('getEncumbranceMult: swaps size and calculates correct multiplier from current size', async () => {
    // Base size is medium. Current size is large (due to effects).
    // Under standard CharEncumbranceManager5E, base size medium = 1x mult.
    // Under EncumbranceManagerSM, size should be swapped to currentsize (large), yielding 2x mult.
    await lua.doString(`
      nodeChar = DB.createNode("charsheet.id-00001")
      DB.setValue(nodeChar, "size", "string", "medium")
      DB.setValue(nodeChar, "currentsize", "string", "large")
    `);
    const multWithoutSwap = await lua.doString(`return CharEncumbranceManager5E.getEncumbranceMult(nodeChar)`);
    assert.strictEqual(multWithoutSwap, 1);

    const multWithSwap = await lua.doString(`return EncumbranceManagerSM.getEncumbranceMult(nodeChar)`);
    assert.strictEqual(multWithSwap, 2);
  });

  // --- HANDLER TRIGGER TESTS & OPTIONS ---
  await resetDB();
  test('onSizeChanged: updates encumbrance limit for PCs', async () => {
    await lua.doString(`
      nodeCombatant = DB.createNode("combattracker.list.id-00001")
      nodeChar = DB.createNode("charsheet.id-00001")
      
      ActorManager._actorTypes["combattracker.list.id-00001"] = "pc"
      ActorManager._actorChars["combattracker.list.id-00001"] = nodeChar
      
      EncumbranceManagerSM.onSizeChanged(nodeCombatant)
    `);
    const calls = await lua.doString(`return CharEncumbranceManager5E.updateLimitCalled["charsheet.id-00001"]`);
    assert.strictEqual(calls, 1);
  });

  test('onSpaceChanged: reacts to space changes, scaling token if TASG option enabled', async () => {
    await lua.doString(`
      nodeCombatant = DB.createNode("combattracker.list.id-00001")
      CombatManager._tokens["combattracker.list.id-00001"] = "token_object"
    `);

    // TASG option disabled (empty)
    await lua.doString(`
      OptionsManager._options["TASG"] = ""
      TokenManagerSM.onSpaceChanged(nodeCombatant)
    `);
    let helperCalls = await lua.doString(`return TokenManager.updateSizeHelperCalled`);
    let scaleCalls = await lua.doString(`return TokenManager.autoTokenScaleCalled`);
    assert.strictEqual(helperCalls, 1);
    assert.strictEqual(scaleCalls, 0);

    // TASG option enabled
    await lua.doString(`
      OptionsManager._options["TASG"] = "on"
      TokenManagerSM.onSpaceChanged(nodeCombatant)
    `);
    helperCalls = await lua.doString(`return TokenManager.updateSizeHelperCalled`);
    scaleCalls = await lua.doString(`return TokenManager.autoTokenScaleCalled`);
    assert.strictEqual(helperCalls, 2);
    assert.strictEqual(scaleCalls, 1);
  });

  test('DB Handlers Integration: changing size database value triggers handlers', async () => {
    // Set up size change handlers and verify they run when currentsize changes in DB
    await lua.doString(`
      nodeCombatant = DB.createNode("combattracker.list.id-00001")
      ActorManager._actorTypes["combattracker.list.id-00001"] = "pc"
      ActorManager._actorChars["combattracker.list.id-00001"] = nodeCombatant
      
      -- Set a value to trigger the onUpdate event handler registered by SizeManager
      DB.setValue("combattracker.list.id-00001.currentsize", "string", "large")
    `);
    const encumbCalls = await lua.doString(`return CharEncumbranceManager5E.updateLimitCalled["combattracker.list.id-00001"]`);
    // DB.setValue on combattracker.list.id-00001.currentsize -> triggers onCurrentSizeChanged -> calls invokeSizeChangedHandlers
    // -> calls EncumbranceManagerSM.onSizeChanged -> calls CharEncumbranceManager5E.updateEncumbranceLimit
    assert.strictEqual(encumbCalls, 1);
  });

  if (failedTests > 0) {
    console.error(`\n--- ${failedTests} test(s) failed! ---`);
    process.exit(1);
  } else {
    console.log('\n--- All tests passed successfully! ---');
    process.exit(0);
  }
}

runAllTests().catch(err => {
  console.error('Fatal error running tests:', err);
  process.exit(1);
});
