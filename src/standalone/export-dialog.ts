import { exportFormats, isExportFormat, type ExportFormat } from './export-formats';

export interface ExportChoice {
  format: ExportFormat;
  output: string;
}

export interface ExportedFile {
  output: string;
  src?: string;
  warnings?: string[];
}

function dialog(title: string) {
  const element = document.createElement('dialog');
  element.className = 'export-dialog';
  element.setAttribute('aria-label', title);
  const heading = document.createElement('h2');
  heading.textContent = title;
  element.append(heading);
  document.body.append(element);
  element.addEventListener('close', () => element.remove(), { once: true });
  return element;
}

function action(label: string, primary = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = primary ? 'dialog-primary' : 'dialog-secondary';
  button.textContent = label;
  return button;
}

function labeled(label: string, element: HTMLElement) {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;
  wrapper.append(element);
  return wrapper;
}

export function chooseExport(film: string, plan?:{editable:number;rendered:{clip:string;layer:string;properties:string[]}[]}): Promise<ExportChoice | undefined> {
  const sheet = dialog('Export film');
  const form = document.createElement('form');
  const format = document.createElement('select');
  for (const [extension, details] of Object.entries(exportFormats)) {
    format.add(new Option(details.name + ' (.' + extension + ')', extension));
  }
  const detail = document.createElement('p');
  detail.className = 'export-detail';
  const output = document.createElement('input');
  output.type = 'text';
  output.required = true;
  output.spellcheck = false;
  output.autocomplete = 'off';
  output.value = 'output/' + film.replace(/\.cut$/i, '') + '.prproj';
  const update = () => {
    if (!isExportFormat(format.value)) return;
    detail.textContent = exportFormats[format.value].detail;
    if(format.value==='prproj' && plan) {
      detail.textContent += ' ' + plan.editable + ' clips use native media and controls.';
      if(plan.rendered.length) detail.textContent += ' These layers get rendered companion media: ' + plan.rendered.map(c=>c.layer+' '+c.clip+' ('+c.properties.join(', ')+')').join(' · ')+'. Their clip positions stay editable.';
    }
    const base = output.value.trim().replace(/\.(?:prproj|drp|mp4|xml)$/i, '');
    output.value = base + '.' + format.value;
    output.setCustomValidity('');
  };
  format.addEventListener('change', update);
  output.addEventListener('input', () => output.setCustomValidity(''));
  update();
  const actions = document.createElement('footer');
  const cancel = action('Cancel');
  cancel.addEventListener('click', () => sheet.close());
  const submit = action('Export', true);
  submit.type = 'submit';
  actions.append(cancel, submit);
  form.append(labeled('Format', format), detail, labeled('File in project', output), actions);
  sheet.append(form);
  return new Promise((resolve) => {
    let choice: ExportChoice | undefined;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const selected = format.value;
      const path = output.value.trim();
      if (!isExportFormat(selected)) return;
      if (
        !path.toLowerCase().endsWith('.' + selected) ||
        !path
          .split('/')
          .at(-1)
          ?.slice(0, -(selected.length + 1))
      ) {
        output.setCustomValidity('Enter a filename ending in .' + selected + '.');
        output.reportValidity();
        return;
      }
      choice = { format: selected, output: path };
      sheet.close();
    });
    sheet.addEventListener('close', () => resolve(choice), { once: true });
    sheet.showModal();
  });
}

export function showExported(file: ExportedFile, reveal?: (path: string) => void) {
  const sheet = dialog('Export complete');
  const location = document.createElement('p');
  location.className = 'export-location';
  location.textContent = file.output;
  sheet.append(location);
  if (file.warnings?.length) {
    const list = document.createElement('ul');
    for (const warning of file.warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.append(item);
    }
    sheet.append(list);
  }
  const actions = document.createElement('footer');
  if (reveal) {
    const finder = action('Show in Finder');
    finder.addEventListener('click', () => reveal(file.output));
    actions.append(finder);
  } else if (file.src) {
    const download = document.createElement('a');
    download.href = file.src;
    download.download = file.output.split('/').pop() || file.output;
    download.textContent = 'Download file';
    actions.append(download);
  }
  const done = action('Done', true);
  done.addEventListener('click', () => sheet.close());
  actions.append(done);
  sheet.append(actions);
  sheet.showModal();
  done.focus();
}
