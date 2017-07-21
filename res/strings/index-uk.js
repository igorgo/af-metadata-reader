/**
 * Created by igorgo on 06.07.2017.
 */
const strings = {
    oneMoreOne: 'Тільки один',
    dbAliasPrompt: 'Псевдонім БД з tnsnames.ora',
    dbUserPrompt: 'Схема БД',
    dbPassPrompt: 'Пароль',
    rootDirPrompt: 'Директорія для збереження метаданих',
    oneMorePrompt: 'Скільки класів потрібно вивантажити?',
    oneMoreMore: 'Декілька',
    singleClassPrompt : 'Код класу, який потрібно вивантажити:',
    recursivePrompt: 'Вивантажити класси рекурсивно?',
    moreTypePrompt: 'Метод зазначення класів для вивантаження?',
    moreTypeAll: 'Всі класи',
    moreTypeG: 'Класи, у яких код більше або дорівнює…',
    moreTypeL: 'Класи, у яких код менше або дорівнює…',
    moreTypeR: 'Діапазон кодів класів',
    startClassPrompt: 'Код майстер-класу, з якого потрібно почати:',
    finishClassPrompt: 'Код майстер-класу, на якому потрібно закінчити:',
    techTypePrompt: 'Тип класів:',
    techTypeAll: 'Будь-які',
    techTypeS: 'Тільки стандартні класи',
    techTypeU: 'Тільки класи користувача',
    onlyFilledPrompt: 'Пропускати класи, що не мають жодного атрибута?',
    connectMessage: 'Підключення до БД… ',
    connectedMessage: ' …підключено!',
    closeDbMessage: 'Завершення сеансу роботи з БД… ',
    closedDbMessage: ' …завершено!',
    extrStart: 'Зачекайте, триває процес вивантаження метаданих…',
    inclJson: 'Вивантажувати метадані також у форматі json',
    extrSucc: 'Вивантаження успішно завершено!'
}

module.exports = strings