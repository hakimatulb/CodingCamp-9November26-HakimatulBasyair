(function () {
  'use strict';

  // ===== StorageService =====
  var StorageService = (function () {
    var _available = null;

    function isAvailable() {
      if (_available !== null) return _available;
      try {
        var probe = '__storage_probe__';
        localStorage.setItem(probe, '1');
        localStorage.getItem(probe);
        localStorage.removeItem(probe);
        _available = true;
      } catch (e) {
        _available = false;
      }
      return _available;
    }

    function load() {
      try {
        var raw = localStorage.getItem('transactions');
        if (raw === null) return [];
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(function (record) {
          return (
            record !== null &&
            typeof record === 'object' &&
            typeof record.id === 'string' &&
            typeof record.name === 'string' &&
            typeof record.amount === 'number' &&
            typeof record.category === 'string' &&
            typeof record.timestamp === 'string'
          );
        });
      } catch (e) {
        return [];
      }
    }

    function save(txns) {
      if (!isAvailable()) return;
      try {
        localStorage.setItem('transactions', JSON.stringify(txns));
      } catch (e) {
        // quota or other error — persist silently
      }
    }

    return { isAvailable: isAvailable, load: load, save: save };
  }());

  // ===== Model (State) =====

  var State = {
    transactions: [],
    activeView: 'list'
  };

  // ===== Pure helpers =====

  function computeTotal(txns) {
    return txns.reduce(function (sum, tx) {
      return sum + tx.amount;
    }, 0);
  }

  function computeCategoryTotals(txns) {
    var totals = new Map();
    txns.forEach(function (tx) {
      var current = totals.get(tx.category) || 0;
      totals.set(tx.category, current + tx.amount);
    });
    totals.forEach(function (value, key) {
      if (value <= 0) totals.delete(key);
    });
    return totals;
  }

  function formatCurrency(amount) {
    var rounded = Math.round(amount * 100) / 100;
    var abs = Math.abs(rounded);
    var formatted = abs.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
    return (rounded < 0 ? '-$' : '$') + formatted;
  }

  function groupByMonth(txns) {
    var groupMap = new Map();

    txns.forEach(function (tx) {
      var date     = new Date(tx.timestamp);
      var year     = date.getFullYear();
      var month    = date.getMonth() + 1;
      var monthKey = year + '-' + (month < 10 ? '0' + month : '' + month);

      if (!groupMap.has(monthKey)) {
        var label = new Date(monthKey + '-01').toLocaleString('en-US', {
          month: 'long',
          year:  'numeric'
        });
        groupMap.set(monthKey, {
          monthKey:     monthKey,
          label:        label,
          transactions: [],
          total:        0
        });
      }

      var group = groupMap.get(monthKey);
      group.transactions.push(tx);
      group.total += tx.amount;
    });

    var groups = [];
    groupMap.forEach(function (group) { groups.push(group); });
    groups.sort(function (a, b) {
      if (a.monthKey > b.monthKey) return -1;
      if (a.monthKey < b.monthKey) return  1;
      return 0;
    });

    return groups;
  }

  // ===== Validator =====

  var VALID_CATEGORIES = ['Shopping', 'Food', 'Transport', 'Health', 'Entertainment', 'Other'];

  function validate(itemName, amountStr, category) {
    var errors = {};

    if (typeof itemName !== 'string' || itemName.trim().length === 0) {
      errors.itemName = 'Item name is required.';
    }

    var amountNum   = parseFloat(amountStr);
    var amountValid = true;

    if (amountStr === '' || amountStr === null || amountStr === undefined || isNaN(amountNum)) {
      amountValid = false;
    } else if (amountNum < 0.01 || amountNum > 999999999.99) {
      amountValid = false;
    } else if (Math.round(amountNum * 100) / 100 !== amountNum) {
      amountValid = false;
    }

    if (!amountValid) {
      errors.amount = 'Amount must be a number between 0.01 and 999,999,999.99 with up to 2 decimal places.';
    }

    if (VALID_CATEGORIES.indexOf(category) === -1) {
      errors.category = 'Please select a valid category.';
    }

    if (Object.keys(errors).length === 0) return { valid: true };
    return { valid: false, errors: errors };
  }

  // ===== Renderer =====

  var Renderer = (function () {

    function renderBalance(total) {
      document.getElementById('balance-amount').textContent = formatCurrency(total);
    }

    function renderList(txns) {
      var list     = document.getElementById('transaction-list');
      var emptyMsg = document.getElementById('empty-message');

      list.innerHTML = '';

      if (txns.length === 0) {
        emptyMsg.classList.remove('hidden');
        return;
      }

      emptyMsg.classList.add('hidden');

      txns.forEach(function (tx) {
        var li = document.createElement('li');
        li.className = 'transaction-item';

        var nameSpan = document.createElement('span');
        nameSpan.className = 'transaction-item__name';
        nameSpan.textContent = tx.name;

        var amountSpan = document.createElement('span');
        amountSpan.className = 'transaction-item__amount';
        amountSpan.textContent = formatCurrency(tx.amount);

        var categorySpan = document.createElement('span');
        categorySpan.className = 'transaction-item__category';
        categorySpan.textContent = tx.category;

        var deleteBtn = document.createElement('button');
        deleteBtn.className = 'transaction-item__delete';
        deleteBtn.type = 'button';
        deleteBtn.setAttribute('data-id', tx.id);
        deleteBtn.setAttribute('aria-label', 'Delete ' + tx.name);
        deleteBtn.textContent = '\u2715';

        li.appendChild(nameSpan);
        li.appendChild(amountSpan);
        li.appendChild(categorySpan);
        li.appendChild(deleteBtn);

        list.appendChild(li);
      });
    }

    function showStorageWarning() {
      document.getElementById('storage-warning').classList.remove('hidden');
    }

    function showChartError() {
      document.getElementById('chart-error-message').classList.remove('hidden');
    }

    var _chartInstance = null;

    var CATEGORY_COLOURS = {
      Shopping:      '#4F81BD',
      Food:          '#C0504D',
      Transport:     '#9BBB59',
      Health:        '#8064A2',
      Entertainment: '#4BACC6',
      Other:         '#F79646'
    };

    function renderChart(txns) {
      if (!window._chartAvailable) return;

      var canvasEl   = document.getElementById('spending-chart');
      var emptyMsgEl = document.getElementById('chart-empty-message');
      var totals     = computeCategoryTotals(txns);

      if (totals.size === 0) {
        canvasEl.classList.add('hidden');
        emptyMsgEl.classList.remove('hidden');
        if (_chartInstance !== null) {
          _chartInstance.destroy();
          _chartInstance = null;
        }
        return;
      }

      emptyMsgEl.classList.add('hidden');
      canvasEl.classList.remove('hidden');

      if (_chartInstance !== null) {
        _chartInstance.destroy();
        _chartInstance = null;
      }

      var labels  = [];
      var data    = [];
      var colours = [];

      totals.forEach(function (value, key) {
        labels.push(key);
        data.push(value);
        colours.push(CATEGORY_COLOURS[key] || '#cccccc');
      });

      _chartInstance = new Chart(canvasEl, {
        type: 'pie',
        data: {
          labels: labels,
          datasets: [{ data: data, backgroundColor: colours }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { display: true, position: 'bottom' }
          }
        }
      });
    }

    function renderMonthlySummary(txns) {
      var container = document.getElementById('monthly-summary-container');

      container.innerHTML = '';

      if (txns.length === 0) {
        var emptyClone = document.createElement('p');
        emptyClone.className = 'hidden'; // reuse styling but keep original in place
        emptyClone.id = 'monthly-empty-message';
        emptyClone.textContent = 'No transactions recorded yet.';
        emptyClone.classList.remove('hidden');
        container.appendChild(emptyClone);
        return;
      }

      var groups = groupByMonth(txns);

      groups.forEach(function (group) {
        var groupDiv = document.createElement('div');
        groupDiv.className = 'month-group';

        var header = document.createElement('h3');
        header.className = 'month-group__header';

        var labelSpan = document.createElement('span');
        labelSpan.className = 'month-group__label';
        labelSpan.textContent = group.label;

        var totalSpan = document.createElement('span');
        totalSpan.className = 'month-group__total';
        totalSpan.textContent = formatCurrency(group.total);

        header.appendChild(labelSpan);
        header.appendChild(totalSpan);

        var ul = document.createElement('ul');
        ul.className = 'month-group__list';

        group.transactions.forEach(function (tx) {
          var li = document.createElement('li');
          li.className = 'transaction-item';

          var nameSpan = document.createElement('span');
          nameSpan.className = 'transaction-item__name';
          nameSpan.textContent = tx.name;

          var amountSpan = document.createElement('span');
          amountSpan.className = 'transaction-item__amount';
          amountSpan.textContent = formatCurrency(tx.amount);

          var categorySpan = document.createElement('span');
          categorySpan.className = 'transaction-item__category';
          categorySpan.textContent = tx.category;

          li.appendChild(nameSpan);
          li.appendChild(amountSpan);
          li.appendChild(categorySpan);

          ul.appendChild(li);
        });

        groupDiv.appendChild(header);
        groupDiv.appendChild(ul);
        container.appendChild(groupDiv);
      });
    }

    return {
      renderBalance:        renderBalance,
      renderList:           renderList,
      renderMonthlySummary: renderMonthlySummary,
      showStorageWarning:   showStorageWarning,
      showChartError:       showChartError,
      renderChart:          renderChart
    };
  }());

  // ===== Controller =====

  var Controller = (function () {

    function init() {
      if (!StorageService.isAvailable()) {
        Renderer.showStorageWarning();
      }

      State.transactions = StorageService.load();

      Renderer.renderList(State.transactions);
      Renderer.renderBalance(computeTotal(State.transactions));
      Renderer.renderChart(State.transactions);

      if (!window._chartAvailable) {
        Renderer.showChartError();
      }

      document.getElementById('transaction-form').addEventListener('submit', handleAddTx);

      document.getElementById('transaction-list').addEventListener('click', function (event) {
        var id = event.target.getAttribute('data-id');
        if (id) handleDeleteTx(id);
      });

      document.getElementById('tab-all').addEventListener('click', function () {
        State.activeView = 'list';
        document.getElementById('all-transactions-container').classList.remove('hidden');
        document.getElementById('monthly-summary-container').classList.add('hidden');
        document.getElementById('tab-all').classList.add('view-tab--active');
        document.getElementById('tab-all').setAttribute('aria-selected', 'true');
        document.getElementById('tab-monthly').classList.remove('view-tab--active');
        document.getElementById('tab-monthly').setAttribute('aria-selected', 'false');
      });

      document.getElementById('tab-monthly').addEventListener('click', function () {
        State.activeView = 'monthly';
        document.getElementById('all-transactions-container').classList.add('hidden');
        document.getElementById('monthly-summary-container').classList.remove('hidden');
        document.getElementById('tab-monthly').classList.add('view-tab--active');
        document.getElementById('tab-monthly').setAttribute('aria-selected', 'true');
        document.getElementById('tab-all').classList.remove('view-tab--active');
        document.getElementById('tab-all').setAttribute('aria-selected', 'false');
        Renderer.renderMonthlySummary(State.transactions);
      });
    }

    function handleAddTx(event) {
      event.preventDefault();

      var itemNameEl = document.getElementById('item-name');
      var amountEl   = document.getElementById('amount');
      var categoryEl = document.getElementById('category');

      var itemName  = itemNameEl.value;
      var amountStr = amountEl.value;
      var category  = categoryEl.value;

      _clearErrors();

      var result = validate(itemName, amountStr, category);

      if (!result.valid) {
        if (result.errors.itemName) _showError('err-item-name', result.errors.itemName);
        if (result.errors.amount)   _showError('err-amount',    result.errors.amount);
        if (result.errors.category) _showError('err-category',  result.errors.category);
        return;
      }

      var newTx = {
        id:        crypto.randomUUID(),
        name:      itemName.trim(),
        amount:    parseFloat(amountStr),
        category:  category,
        timestamp: new Date().toISOString()
      };

      State.transactions.push(newTx);
      StorageService.save(State.transactions);

      Renderer.renderList(State.transactions);
      Renderer.renderBalance(computeTotal(State.transactions));
      Renderer.renderChart(State.transactions);

      if (State.activeView === 'monthly') {
        Renderer.renderMonthlySummary(State.transactions);
      }

      itemNameEl.value = '';
      amountEl.value   = '';
      categoryEl.value = 'Shopping';
    }

    function handleDeleteTx(id) {
      State.transactions = State.transactions.filter(function (tx) {
        return tx.id !== id;
      });

      StorageService.save(State.transactions);

      Renderer.renderList(State.transactions);
      Renderer.renderBalance(computeTotal(State.transactions));
      Renderer.renderChart(State.transactions);

      if (State.activeView === 'monthly') {
        Renderer.renderMonthlySummary(State.transactions);
      }
    }

    function _showError(spanId, message) {
      var el = document.getElementById(spanId);
      if (el) {
        el.textContent = message;
        el.classList.remove('hidden');
      }
    }

    function _clearErrors() {
      ['err-item-name', 'err-amount'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.textContent = '';
          el.classList.add('hidden');
        }
      });
    }

    return {
      init:           init,
      handleAddTx:    handleAddTx,
      handleDeleteTx: handleDeleteTx
    };
  }());

  // Bootstrap
  Controller.init();
})();
