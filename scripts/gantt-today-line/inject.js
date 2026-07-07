// Positions #__vikunja-today-line (see inject.css) on top of the Gantt
// chart's date column that matches "today", per go-vikunja/vikunja's
// GanttTimelineHeader.vue: the current-day cell gets a
// `.timeunit-wrapper.today` class inside `.timeunit`, and the whole
// scrollable chart lives in `.gantt-chart-wrapper`. We read that cell's
// position instead of recomputing dayWidthPixels ourselves, so this stays
// correct across window resizes and date-range changes without needing to
// touch Vikunja's own layout logic.
(function () {
	'use strict';

	const LINE_ID = '__vikunja-today-line';

	function ensureLine(wrapper) {
		let line = wrapper.querySelector('#' + LINE_ID);
		if (!line) {
			line = document.createElement('div');
			line.id = LINE_ID;
			wrapper.appendChild(line);
		}
		return line;
	}

	function reposition() {
		const wrapper = document.querySelector('.gantt-chart-wrapper');
		if (!wrapper) return;

		const todayCell = wrapper.querySelector('.timeunit-wrapper.today');
		const existingLine = wrapper.querySelector('#' + LINE_ID);

		// Today isn't inside the currently selected date range: nothing to draw.
		if (!todayCell) {
			if (existingLine) existingLine.remove();
			return;
		}

		const timeunit = todayCell.closest('.timeunit');
		if (!timeunit) return;

		const wrapperRect = wrapper.getBoundingClientRect();
		const cellRect = timeunit.getBoundingClientRect();
		const centerX = cellRect.left - wrapperRect.left + cellRect.width / 2;

		ensureLine(wrapper).style.left = centerX + 'px';
	}

	let scheduled = false;
	function scheduleReposition() {
		if (scheduled) return;
		scheduled = true;
		requestAnimationFrame(() => {
			scheduled = false;
			reposition();
		});
	}

	// Vikunja is an SPA (no full page reload between views), so watch the DOM
	// for the Gantt chart mounting/unmounting/re-rendering instead of relying
	// on page-load timing.
	new MutationObserver(scheduleReposition).observe(document.body, {
		childList: true,
		subtree: true,
		attributes: true,
		attributeFilter: ['class', 'style'],
	});

	window.addEventListener('resize', scheduleReposition);

	// Vikunja's own "today" highlight is reactive and rolls over at midnight
	// without a page reload (useGlobalNow()); re-check periodically so ours does too.
	setInterval(scheduleReposition, 60 * 1000);

	scheduleReposition();
})();

// Lets the user click-drag anywhere in the empty area of the Gantt chart to
// pan it, instead of having to hunt for the horizontal scrollbar (and
// whatever ancestor element owns vertical scrolling) once a project has
// enough tasks that they run off screen. Vikunja's own GanttChart.vue already
// binds a pointerdown handler on `.gantt-bar` to let the user drag a task bar
// to reschedule it, so this has to explicitly stay out of that element's way
// rather than intercepting pointer events on the chart as a whole.
(function () {
	'use strict';

	const DRAG_THRESHOLD_PX = 4;
	let pan = null;

	// The Gantt view only scrolls horizontally on `.gantt-container` itself
	// (see its `overflow-x: auto`); vertical scrolling belongs to whichever
	// ancestor layout element actually overflows. Walk up to find it instead
	// of hard-coding a layout class name that isn't part of the Gantt
	// component itself and could change independently of it.
	function findVerticalScrollAncestor(el) {
		let node = el.parentElement;
		while (node && node !== document.body) {
			const style = getComputedStyle(node);
			if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) {
				return node;
			}
			node = node.parentElement;
		}
		return document.scrollingElement || document.documentElement;
	}

	document.addEventListener('pointerdown', (event) => {
		if (event.button !== 0) return;
		const container = event.target.closest('.gantt-container');
		if (!container) return;
		if (event.target.closest('.gantt-bar, button, a, input, textarea, select')) return;

		pan = {
			container,
			vScrollEl: findVerticalScrollAncestor(container),
			startX: event.clientX,
			startY: event.clientY,
			startScrollLeft: container.scrollLeft,
			startScrollTop: 0,
			moved: false,
		};
		pan.startScrollTop = pan.vScrollEl.scrollTop;
	});

	document.addEventListener('pointermove', (event) => {
		if (!pan) return;
		const dx = event.clientX - pan.startX;
		const dy = event.clientY - pan.startY;

		if (!pan.moved) {
			if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
			pan.moved = true;
			document.body.style.userSelect = 'none';
			document.body.style.cursor = 'grabbing';
		}

		pan.container.scrollLeft = pan.startScrollLeft - dx;
		pan.vScrollEl.scrollTop = pan.startScrollTop - dy;
		event.preventDefault();
	});

	function endPan() {
		if (pan && pan.moved) {
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
		}
		pan = null;
	}
	document.addEventListener('pointerup', endPan);
	document.addEventListener('pointercancel', endPan);
})();
